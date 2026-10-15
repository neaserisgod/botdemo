#!/usr/bin/env python3
"""Busca cuentas de Instagram de negocios de una ciudad en DuckDuckGo, sin entrar a Instagram.

El resultado de DuckDuckGo ya trae los seguidores y la bio de cada cuenta: con eso se califica igual que en
docs/PROSPECTOS.md (punto dulce de 500 a 10.000 seguidores, "turnos por DM", seña, home studio, si vende insumos).
Saltea las cuentas que ya están en PROSPECTOS.md. Gratis y sin clave. Bing y Google no sirven: a los programas les
devuelven resultados que no tienen nada que ver o los bloquean.

    python3 buscar_instagram.py --ciudad Bariloche --codigo brc --max 15
"""

import argparse
import csv
import logging
import re
import sys
import time
from urllib.parse import parse_qs, quote_plus, urlparse

import prospectar as p

TERMINOS = {
    'unas': ['nails', 'uñas'],
    'barberia': ['barbería', 'barber'],
    'peluqueria': ['peluquería'],
    'estetica': ['estética', 'cejas pestañas'],
}

FRASES_BIO = {
    **p.FRASES,
    'reserva por mensaje': re.compile(r'(pedi|reserva|saca|agenda)\w*\s+(tu\s+|su\s+)?turno|turnos?\s+(por\s+)?(aca|abajo|link)'),
}
# Palabras del rubro: sin alguna en la cuenta, el título o la bio, no es un negocio del rubro (filtra a "barbara_brc").
DEL_RUBRO = {
    'unas': re.compile(r'nail|\bunas\b|manicur|semi|kapping|capping|soft\s*gel|esculpid'),
    'barberia': re.compile(r'barber|corte|fade|peluq'),
    'peluqueria': re.compile(r'pelu|hair|estilist|color|corte|alisad'),
    'estetica': re.compile(r'estetic|ceja|pestan|lash|depil|facial|spa|beauty|belleza|brow'),
}
NO_ES_CLIENTE = re.compile(r'insumos|mayorista|distribuidor|venta de productos|tienda|escuela|academia')


def link_real(href):
    """DuckDuckGo esconde el destino en //duckduckgo.com/l/?uddg=<url>."""
    if 'duckduckgo.com/l/' in href:
        return parse_qs(urlparse(href if '//' not in href[:2] else 'https:' + href).query).get('uddg', [href])[0]
    return href


def seguidores(texto):
    """'3,049 Followers' → 3049; '1.2K seguidores' → 1200; '12 mil seguidores' → 12000. None si no dice."""
    m = re.search(r'([\d.,]+)\s*(k|m|mil)?\s*(followers|seguidores)', texto, re.I)
    if not m:
        return None
    numero, sufijo = m.group(1), (m.group(2) or '').lower()
    if sufijo:
        return int(float(numero.replace(',', '.')) * (1_000_000 if sufijo == 'm' else 1000))
    return int(re.sub(r'[.,]', '', numero))


def bio(texto):
    m = re.search(r'(?:on|en) Instagram:\s*"(.*)"?', texto)
    if m:
        return m.group(1).strip().strip('"')
    # Sin bio: queda solo "140 Followers, 260 Following, 270 Posts - See Instagram photos and videos from …"
    return '' if re.match(r'[\d.,]+\s*\w*\s*(followers|seguidores)', texto, re.I) else texto.strip()


def resultados(html, url='https://html.duckduckgo.com/'):
    """[{cuenta, titulo, texto}] de una página de resultados de DuckDuckGo (solo cuentas, no publicaciones)."""
    from scrapling.parser import Selector
    salida = []
    for r in Selector(html, url=url).css('.result'):
        cuenta = p.cuenta_instagram(link_real(r.css('a.result__a::attr(href)').get() or ''))
        if cuenta and cuenta != 'instagram':
            salida.append({'cuenta': cuenta, 'titulo': ' '.join(r.css('a.result__a ::text').getall()).strip(),
                           'texto': ' '.join(r.css('.result__snippet ::text').getall()).strip()})
    return salida


def buscar(consulta):
    """(estado, resultados). Estado 202 = DuckDuckGo pidió verificar que sos humano."""
    from scrapling.fetchers import Fetcher
    logging.getLogger('scrapling').setLevel(logging.CRITICAL)
    r = Fetcher.get('https://html.duckduckgo.com/html/?q=' + quote_plus(consulta), timeout=20, stealthy_headers=True)
    return r.status, resultados(r.html_content) if r.status == 200 else []


def es_de_la_ciudad(resultado, ciudad, codigo):
    texto = p.normalizar(resultado['cuenta'] + ' ' + resultado['titulo'] + ' ' + resultado['texto'])
    return p.normalizar(ciudad) in texto or bool(codigo and re.search(r'(^|[^a-z])' + codigo.lower() + r'([^a-z]|$)',
                                                                        texto.replace('.', ' ').replace('_', ' ')))


def es_del_rubro(resultado, rubro):
    return bool(DEL_RUBRO[rubro].search(p.normalizar(resultado['cuenta'] + ' ' + resultado['titulo'] + ' ' + resultado['texto'])))


def calificar(resultado):
    """Agrega seguidores, bio, señales, puntos y prioridad, con los criterios de docs/PROSPECTOS.md."""
    texto = resultado['texto']
    r = {**resultado, 'seguidores': seguidores(texto), 'bio': bio(texto)}
    b = p.normalizar(r['bio'])
    r['senales'] = [nombre for nombre, regex in FRASES_BIO.items() if regex.search(b)]
    s = r['seguidores']
    if NO_ES_CLIENTE.search(b):
        r['puntos'], r['prioridad'] = -5, 'baja (vende insumos o cursos)'
        return r
    if s is not None and s > 50_000:
        r['puntos'], r['prioridad'] = -5, 'baja (cuenta grande)'
        return r
    pts = 0
    pts += 3 if 'turnos por WhatsApp/DM' in r['senales'] or 'reserva por mensaje' in r['senales'] else 0
    pts += 2 if 'pide seña' in r['senales'] else 0
    pts += 1 if 'home studio' in r['senales'] or 'solo con turno' in r['senales'] else 0
    if s is not None:
        pts += 2 if 500 <= s <= 10_000 else 1 if 300 <= s < 500 else -1 if s < 100 else 0
    r['puntos'] = pts
    r['prioridad'] = 'alta' if pts >= 4 else 'media' if pts >= 2 else 'baja'
    return r


def main(argv=None, buscar=buscar, pausa=8):
    ap = argparse.ArgumentParser(description='Cuentas de Instagram de una ciudad, desde DuckDuckGo.')
    ap.add_argument('--ciudad', required=True)
    ap.add_argument('--codigo', default='', help='Código que usan en los nombres de cuenta, ej. brc, nqn, mdp.')
    ap.add_argument('--rubro', action='append', choices=sorted(TERMINOS), help='Se puede repetir. Sin esto, todos.')
    ap.add_argument('--max', type=int, default=15, help='Cuántas cuentas juntar como máximo.')
    ap.add_argument('--excluir', default=p.PROSPECTOS_MD)
    ap.add_argument('--salida', default='instagram.csv')
    a = ap.parse_args(argv)

    excluidos, vistas, cuentas = p.cargar_excluidos(a.excluir), set(), []
    consultas = [(rubro, f'site:instagram.com {t} {lugar}') for rubro in (a.rubro or TERMINOS)
                 for t in TERMINOS[rubro] for lugar in dict.fromkeys(x for x in (a.ciudad, a.codigo) if x)]
    for i, (rubro, consulta) in enumerate(consultas):
        if len(cuentas) >= a.max:
            break
        if i:
            time.sleep(pausa)  # sin apuro: así no parece un robot
        estado, encontrados = buscar(consulta)
        if estado == 202:  # verificación de humano: se espera y se reintenta una vez
            time.sleep(pausa * 5)
            estado, encontrados = buscar(consulta)
        if estado == 202:
            print('DuckDuckGo pidió verificar que sos humano: probá de nuevo en un rato.', file=sys.stderr)
            break
        nuevas = 0
        for r in encontrados:
            if (r['cuenta'] in vistas or r['cuenta'] in excluidos or not es_de_la_ciudad(r, a.ciudad, a.codigo)
                    or not es_del_rubro(r, rubro)):
                continue
            vistas.add(r['cuenta'])
            cuentas.append({**calificar(r), 'rubro': rubro})
            nuevas += 1
        print(f'{consulta}: {nuevas} nuevas', file=sys.stderr)

    cuentas = sorted(cuentas[:a.max], key=lambda c: -c['puntos'])
    with open(a.salida, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f, delimiter=';')
        w.writerow(['Prioridad', 'Cuenta', 'Seguidores', 'Rubro', 'Ciudad', 'Señales', 'Bio', 'Link'])
        for c in cuentas:
            w.writerow([c['prioridad'], '@' + c['cuenta'], '' if c['seguidores'] is None else c['seguidores'], c['rubro'],
                        a.ciudad, ', '.join(c['senales']), c['bio'][:200], f"https://www.instagram.com/{c['cuenta']}/"])
    print(f'{len(cuentas)} cuentas en {a.salida}', file=sys.stderr)
    return cuentas


if __name__ == '__main__':
    main()
