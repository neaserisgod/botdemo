#!/usr/bin/env python3
"""Busca posibles clientes (uñas, barberías, peluquerías, estéticas) por ciudad y arma una planilla para contactarlos a mano.

1. Google Places API (la oficial, legal): negocios por rubro y ciudad, con teléfono, web y reseñas.
2. Scrapling: entra a la web (o al Linktree) de cada uno y saca su Instagram, su WhatsApp, si da turnos por
   WhatsApp o DM, si pide seña y si ya usa otra app de turnos.
3. CSV ordenado por prioridad, con las señales de docs/PROSPECTOS.md. Saltea los que ya están ahí.

No entra a Instagram ni manda mensajes: el contacto es a mano (ver NodoSurPage/marketing/mensajes-directos.md).

    GOOGLE_PLACES_KEY=... python3 prospectar.py --ciudad Cipolletti --rubro unas --rubro barberia
    python3 prospectar.py --urls webs.txt          # sin clave: analiza una lista de webs
"""

import argparse
import csv
import json
import logging
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

AQUI = os.path.dirname(os.path.abspath(__file__))
PROSPECTOS_MD = os.path.join(AQUI, '..', 'docs', 'PROSPECTOS.md')

RUBROS = {
    'unas': ['uñas', 'nail studio', 'manicura'],
    'barberia': ['barbería'],
    'peluqueria': ['peluquería'],
    'estetica': ['centro de estética', 'cejas y pestañas'],
}

# Apps de turnos de la competencia: si el negocio ya usa una, hay que competir contra algo concreto.
APPS_DE_TURNOS = {
    'booksy.com': 'Booksy', 'agendapro.com': 'AgendaPro', 'turnito': 'Turnito', 'reservasimple': 'ReservaSimple',
    'gendu': 'Gendu', 'fresha.com': 'Fresha', 'calendly.com': 'Calendly', 'simplybook': 'SimplyBook',
    'setmore.com': 'Setmore', 'weturno': 'WeTurno', 'turnonet': 'Turnonet', 'tuturno': 'TuTurno',
    'koibox': 'Koibox', 'treatwell': 'Treatwell', 'heygoldie.com': 'HeyGoldie', 'pedituturno': 'Pedí Tu Turno',
}
# Páginas de "todos mis links": se analizan como la web del negocio.
AGREGADORES = ('linktr.ee', 'beacons.ai', 'taplink.cc', 'bio.link', 'linkin.bio', 'campsite.bio')
# Rutas de instagram.com que no son una cuenta.
NO_CUENTAS_IG = {'p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv', 'share', 'direct', 'about', 'developer',
                 'popular'}

FRASES = {
    'turnos por WhatsApp/DM': re.compile(
        r'(turno|reserva|cita)s?\s+(solo\s+)?(por|al|via|x)\s+(whats?app|wsp|wpp|wa|dm|md|privado|mensaje)'),
    'pide seña': re.compile(r'\bsenas?\b'),
    'solo con turno': re.compile(r'(solo|unicamente|previo)\s+(con\s+)?turno|con\s+turno\s+previo'),
    'home studio': re.compile(r'home\s*studio'),
}


def normalizar(texto):
    """Minúsculas y sin tildes ni ñ, para buscar frases sin importar cómo las escriban."""
    t = unicodedata.normalize('NFKD', texto).lower()  # primero NFKD: '𝐓𝐔𝐑𝐍𝐎' → 'TURNO' → 'turno'
    return ''.join(c for c in t if not unicodedata.combining(c))


def cuenta_instagram(url):
    """'https://www.instagram.com/nails.nqn/?hl=es' → 'nails.nqn'; None si no es una cuenta."""
    u = urlparse(url if '//' in url else 'https://' + url)
    if not (u.hostname or '').endswith('instagram.com'):
        return None
    partes = [p for p in u.path.split('/') if p]
    if not partes or partes[0].lower() in NO_CUENTAS_IG:
        return None
    cuenta = partes[0].lower()
    return cuenta if re.fullmatch(r'[a-z0-9._]{1,30}', cuenta) else None


def numero_whatsapp(url):
    """Número de un link wa.me / api.whatsapp.com, o None."""
    m = re.search(r'(?:wa\.me/|whatsapp\.com/send/?\?(?:.*&)?phone=|whatsapp://send\?(?:.*&)?phone=)\+?(\d{8,15})', url)
    return m.group(1) if m else None


def app_de_turnos(url):
    host = (urlparse(url).hostname or '') + urlparse(url).path
    for clave, nombre in APPS_DE_TURNOS.items():
        if clave in host:
            return nombre
    return None


def es_agregador(url):
    return any((urlparse(url).hostname or '').endswith(a) for a in AGREGADORES)


def analizar_html(html, url):
    """Señales de una página: cuentas de Instagram, WhatsApp, app de turnos, frases y links a un Linktree."""
    from scrapling.parser import Selector
    pagina = Selector(html, url=url)
    links = [urljoin(url, h) for h in pagina.css('a::attr(href)').getall() if h]
    texto = normalizar(pagina.get_all_text(ignore_tags=('script', 'style')))
    r = {'instagram': [], 'whatsapp': [], 'apps': [], 'frases': [], 'agregadores': []}
    for link in links:
        for clave, valor in (('instagram', cuenta_instagram(link)), ('whatsapp', numero_whatsapp(link)),
                             ('apps', app_de_turnos(link)), ('agregadores', link if es_agregador(link) else None)):
            if valor and valor not in r[clave]:
                r[clave].append(valor)
    r['frases'] = [nombre for nombre, regex in FRASES.items() if regex.search(texto)]
    return r


def bajar(url):
    """HTML de una web con Scrapling (pedido con huella de navegador real). None si no responde."""
    from scrapling.fetchers import Fetcher
    logging.getLogger('scrapling').setLevel(logging.CRITICAL)  # una web caída no es un error del script
    try:
        r = Fetcher.get(url, timeout=15, retries=1, stealthy_headers=True)
        return r.html_content if r.status == 200 else None
    except Exception:
        return None


def revisar_web(url, bajar=bajar):
    """Analiza la web de un negocio y, si enlaza a un Linktree, también ese (un nivel)."""
    vacio = {'instagram': [], 'whatsapp': [], 'apps': [], 'frases': [], 'agregadores': [], 'web_ok': False}
    if not url:
        return vacio
    # Webs que no se pueden (o no conviene) bajar: se saca lo que dice el propio link.
    if cuenta_instagram(url) or numero_whatsapp(url) or app_de_turnos(url):
        return {**vacio, 'web_ok': True, 'instagram': [c for c in [cuenta_instagram(url)] if c],
                'whatsapp': [n for n in [numero_whatsapp(url)] if n], 'apps': [a for a in [app_de_turnos(url)] if a]}
    html = bajar(url)
    if html is None:
        return vacio
    r = {**analizar_html(html, url), 'web_ok': True}
    for extra in r['agregadores'][:1]:
        html_extra = bajar(extra)
        if html_extra:
            otro = analizar_html(html_extra, extra)
            for clave in ('instagram', 'whatsapp', 'apps', 'frases'):
                r[clave] += [v for v in otro[clave] if v not in r[clave]]
    return r


def buscar_places(consulta, clave, paginas=1, pedir=None):
    """Negocios de Google Places (Text Search). Hasta 20 por página, 3 páginas como máximo."""
    campos = ('places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,'
              'places.rating,places.userRatingCount,places.businessStatus,places.googleMapsUri,nextPageToken')
    pedir = pedir or _post_places
    lugares, token = [], None
    for _ in range(max(1, min(paginas, 3))):
        cuerpo = {'textQuery': consulta, 'languageCode': 'es', 'regionCode': 'AR', 'pageSize': 20}
        if token:
            cuerpo['pageToken'] = token
        respuesta = pedir(cuerpo, clave, campos)
        lugares += respuesta.get('places', [])
        token = respuesta.get('nextPageToken')
        if not token:
            break
    return lugares


def _post_places(cuerpo, clave, campos):
    req = urllib.request.Request(
        'https://places.googleapis.com/v1/places:searchText', data=json.dumps(cuerpo).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'X-Goog-Api-Key': clave, 'X-Goog-FieldMask': campos})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        cuerpo = e.read().decode(errors='replace')
        try:
            cuerpo = json.loads(cuerpo)['error']['message']
        except (ValueError, KeyError, TypeError):
            pass
        sys.exit(f'Google Places respondió {e.code}: {cuerpo[:300]}')


def puntaje(p):
    """Prioridad según las señales de docs/PROSPECTOS.md. Devuelve (puntos, etiqueta)."""
    if p['estado'] not in ('', 'OPERATIONAL'):
        return -10, 'descartar (cerrado)'
    if p['apps']:
        return -5, 'baja (ya usa ' + ', '.join(p['apps']) + ')'
    pts = 0
    pts += 3 if 'turnos por WhatsApp/DM' in p['frases'] else 0
    pts += 2 if 'pide seña' in p['frases'] else 0
    pts += 1 if 'solo con turno' in p['frases'] else 0
    pts += 1 if 'home studio' in p['frases'] else 0
    pts += 1 if p['whatsapp'] else 0
    pts += 1 if p['instagram'] else 0
    if p['resenas'] is not None:
        pts += 1 if p['resenas'] <= 150 else (-1 if p['resenas'] > 500 else 0)  # chico = una persona; muy grande = cadena
    return pts, 'alta' if pts >= 4 else 'media' if pts >= 2 else 'baja'


def cargar_excluidos(ruta):
    """Cuentas de Instagram que ya están en docs/PROSPECTOS.md (o en el archivo que se pase)."""
    if not ruta or not os.path.exists(ruta):
        return set()
    with open(ruta, encoding='utf-8') as f:
        return {c.lower() for c in re.findall(r'instagram\.com/([A-Za-z0-9._]+)', f.read())}


def desde_places(lugar, rubro, ciudad):
    return {
        'id': lugar.get('id', ''), 'nombre': (lugar.get('displayName') or {}).get('text', ''), 'rubro': rubro,
        'ciudad': ciudad, 'direccion': lugar.get('formattedAddress', ''), 'telefono': lugar.get('nationalPhoneNumber', ''),
        'web': lugar.get('websiteUri', ''), 'resenas': lugar.get('userRatingCount'), 'rating': lugar.get('rating'),
        'estado': lugar.get('businessStatus', ''), 'maps': lugar.get('googleMapsUri', ''),
    }


def desde_url(url):
    return {'id': url, 'nombre': '', 'rubro': '', 'ciudad': '', 'direccion': '', 'telefono': '', 'web': url,
            'resenas': None, 'rating': None, 'estado': '', 'maps': ''}


def completar(negocios, excluidos=frozenset(), revisar=revisar_web, hilos=6):
    """Revisa la web de cada negocio, calcula la prioridad y saca los repetidos y los ya conocidos."""
    with ThreadPoolExecutor(hilos) as pool:
        revisiones = list(pool.map(lambda n: revisar(n['web']), negocios))
    vistos, salida = set(), []
    for n, r in zip(negocios, revisiones):
        n = {**n, **{k: r[k] for k in ('instagram', 'whatsapp', 'apps', 'frases')}, 'web_ok': r['web_ok']}
        if any(c in excluidos for c in n['instagram']):
            continue
        claves = {n['id']} | {'ig:' + c for c in n['instagram']}
        if claves & vistos:
            continue
        vistos |= claves
        n['puntos'], n['prioridad'] = puntaje(n)
        salida.append(n)
    salida.sort(key=lambda n: -n['puntos'])
    return salida


COLUMNAS = ['Prioridad', 'Cuenta', 'Nombre', 'Rubro', 'Ciudad', 'Señales', 'WhatsApp', 'Teléfono', 'Web', 'Reseñas',
            'Dirección', 'Maps']


def fila(n):
    return [n['prioridad'], ' '.join('@' + c for c in n['instagram']), n['nombre'], n['rubro'], n['ciudad'],
            ', '.join(n['frases']) + ('' if n['web_ok'] or not n['web'] else ' (web no respondió)'),
            ' '.join(n['whatsapp']), n['telefono'], n['web'],
            '' if n['resenas'] is None else f"{n['resenas']} ({n['rating']})", n['direccion'], n['maps']]


def guardar_csv(negocios, ruta):
    # Punto y coma y BOM: así lo abre bien el Excel en castellano (y Google Sheets también).
    with open(ruta, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f, delimiter=';')
        w.writerow(COLUMNAS)
        w.writerows(fila(n) for n in negocios)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Busca posibles clientes y arma una planilla para contactarlos a mano.')
    ap.add_argument('--ciudad', action='append', default=[], help='Se puede repetir: --ciudad Cipolletti --ciudad Neuquén')
    ap.add_argument('--rubro', action='append', choices=sorted(RUBROS), help='Se puede repetir. Sin esto, todos.')
    ap.add_argument('--paginas', type=int, default=1, help='Páginas de 20 por búsqueda (1 a 3). Cada una es un pedido a Google.')
    ap.add_argument('--urls', help='Archivo con una web por línea: las analiza sin usar Google (no hace falta clave).')
    ap.add_argument('--excluir', default=PROSPECTOS_MD, help='Saltea las cuentas de Instagram que ya están en este archivo.')
    ap.add_argument('--salida', default='prospectos.csv')
    a = ap.parse_args(argv)

    if a.urls:
        with open(a.urls, encoding='utf-8') as f:
            negocios = [desde_url(l.strip()) for l in f if l.strip() and not l.startswith('#')]
    else:
        clave = os.environ.get('GOOGLE_PLACES_KEY')
        if not clave or not a.ciudad:
            ap.error('hace falta --ciudad y la variable GOOGLE_PLACES_KEY (o usar --urls)')
        negocios = []
        for ciudad in a.ciudad:
            for rubro in a.rubro or sorted(RUBROS):
                for termino in RUBROS[rubro]:
                    consulta = f'{termino} en {ciudad}'
                    lugares = buscar_places(consulta, clave, a.paginas)
                    print(f'{consulta}: {len(lugares)}', file=sys.stderr)
                    negocios += [desde_places(l, rubro, ciudad) for l in lugares]

    print(f'Revisando {len(negocios)} webs…', file=sys.stderr)
    salida = completar(negocios, cargar_excluidos(a.excluir))
    guardar_csv(salida, a.salida)
    resumen = {e: sum(n['prioridad'].startswith(e) for n in salida) for e in ('alta', 'media', 'baja')}
    print(f"{len(salida)} prospectos en {a.salida} — alta {resumen['alta']}, media {resumen['media']}, baja {resumen['baja']}",
          file=sys.stderr)


if __name__ == '__main__':
    main()
