"""Pruebas sin red: Google Places y las webs están simuladas.  python3 -m unittest test_prospectar"""

import csv
import os
import tempfile
import unittest

import prospectar as p

WEB_UNAS = '''<html><body>
<h1>Meli Nails · Home Studio</h1>
<p>Turnos por WhatsApp. Para reservar se abona una seña por transferencia.</p>
<a href="https://www.instagram.com/meli.nails.nqn/?hl=es">Instagram</a>
<a href="https://www.instagram.com/p/C123abc/">una publicación</a>
<a href="https://wa.me/5492991234567?text=hola">WhatsApp</a>
<script>var turnos_por_whatsapp = "esto no cuenta";</script>
</body></html>'''

WEB_BARBERIA = '''<html><body><p>Reservá tu turno online</p>
<a href="https://booksy.com/es-ar/12345_barber-king">Reservar</a>
<a href="https://instagram.com/barberking_nqn">IG</a></body></html>'''

WEB_CON_LINKTREE = '<html><body><p>Peluquería</p><a href="https://linktr.ee/cortes.ana">mis links</a></body></html>'
LINKTREE = '''<html><body><a href="https://instagram.com/cortes.ana">IG</a>
<a href="https://api.whatsapp.com/send?phone=5492944111222">Turnos por WSP</a></body></html>'''

WEBS = {'https://melinails.com.ar/': WEB_UNAS, 'https://barberking.com/': WEB_BARBERIA,
        'https://cortesana.com/': WEB_CON_LINKTREE, 'https://linktr.ee/cortes.ana': LINKTREE}


def bajar_falso(url):
    return WEBS.get(url)


def lugar(id_, nombre, web, resenas=40, estado='OPERATIONAL'):
    return {'id': id_, 'displayName': {'text': nombre}, 'websiteUri': web, 'userRatingCount': resenas, 'rating': 4.9,
            'businessStatus': estado, 'formattedAddress': 'Neuquén', 'nationalPhoneNumber': '0299 123-4567'}


class Links(unittest.TestCase):
    def test_cuenta_instagram(self):
        self.assertEqual(p.cuenta_instagram('https://www.instagram.com/Nails.NQN/?hl=es'), 'nails.nqn')
        self.assertEqual(p.cuenta_instagram('instagram.com/kira_nailsbrc'), 'kira_nailsbrc')
        self.assertIsNone(p.cuenta_instagram('https://www.instagram.com/p/C123/'))
        self.assertIsNone(p.cuenta_instagram('https://www.instagram.com/'))
        self.assertIsNone(p.cuenta_instagram('https://facebook.com/nails'))

    def test_numero_whatsapp(self):
        self.assertEqual(p.numero_whatsapp('https://wa.me/5492944796044?text=hola'), '5492944796044')
        self.assertEqual(p.numero_whatsapp('https://api.whatsapp.com/send?phone=+5492991234567&text=x'), '5492991234567')
        self.assertEqual(p.numero_whatsapp('https://api.whatsapp.com/send/?text=x&phone=5492991234567'), '5492991234567')
        self.assertIsNone(p.numero_whatsapp('https://whatsapp.com/'))

    def test_app_de_turnos(self):
        self.assertEqual(p.app_de_turnos('https://booksy.com/es-ar/123'), 'Booksy')
        self.assertEqual(p.app_de_turnos('https://agendapro.com/ar/sucursal/x'), 'AgendaPro')
        self.assertIsNone(p.app_de_turnos('https://melinails.com.ar/'))


class Analisis(unittest.TestCase):
    def test_senales_de_una_web(self):
        r = p.analizar_html(WEB_UNAS, 'https://melinails.com.ar/')
        self.assertEqual(r['instagram'], ['meli.nails.nqn'])
        self.assertEqual(r['whatsapp'], ['5492991234567'])
        self.assertEqual(r['apps'], [])
        self.assertEqual(set(r['frases']), {'turnos por WhatsApp/DM', 'pide seña', 'home studio'})

    def test_los_scripts_no_cuentan(self):
        r = p.analizar_html('<p>Hola</p><script>turnos por whatsapp</script>', 'https://x.com/')
        self.assertEqual(r['frases'], [])

    def test_sigue_el_linktree(self):
        r = p.revisar_web('https://cortesana.com/', bajar=bajar_falso)
        self.assertEqual(r['instagram'], ['cortes.ana'])
        self.assertEqual(r['whatsapp'], ['5492944111222'])
        self.assertIn('turnos por WhatsApp/DM', r['frases'])

    def test_web_que_es_instagram_no_se_baja(self):
        def no_bajar(url):
            raise AssertionError('no tiene que entrar a Instagram')
        r = p.revisar_web('https://www.instagram.com/glowstudiobrc/', bajar=no_bajar)
        self.assertEqual(r['instagram'], ['glowstudiobrc'])
        self.assertTrue(r['web_ok'])  # no figura como "web no respondió"

    def test_web_caida(self):
        r = p.revisar_web('https://no-anda.com/', bajar=bajar_falso)
        self.assertFalse(r['web_ok'])


class Places(unittest.TestCase):
    def test_pagina_hasta_que_no_hay_token(self):
        pedidos = []

        def pedir(cuerpo, clave, campos):
            pedidos.append(cuerpo)
            self.assertIn('places.websiteUri', campos)
            self.assertEqual(cuerpo['textQuery'], 'uñas en Neuquén')
            return {'places': [lugar('a', 'A', '')], 'nextPageToken': 'T2'} if 'pageToken' not in cuerpo \
                else {'places': [lugar('b', 'B', '')]}
        lugares = p.buscar_places('uñas en Neuquén', 'clave', paginas=3, pedir=pedir)
        self.assertEqual([l['id'] for l in lugares], ['a', 'b'])
        self.assertEqual(pedidos[1]['pageToken'], 'T2')

    def test_una_pagina_por_defecto(self):
        pedidos = []
        p.buscar_places('x', 'k', pedir=lambda c, k, f: pedidos.append(c) or {'places': [], 'nextPageToken': 'T'})
        self.assertEqual(len(pedidos), 1)


class Prioridad(unittest.TestCase):
    def armar(self, lugares, excluidos=frozenset()):
        negocios = [p.desde_places(l, 'unas', 'Neuquén') for l in lugares]
        return p.completar(negocios, excluidos, revisar=lambda url: p.revisar_web(url, bajar=bajar_falso))

    def test_orden_y_etiquetas(self):
        salida = self.armar([
            lugar('1', 'Barber King', 'https://barberking.com/'),
            lugar('2', 'Meli Nails', 'https://melinails.com.ar/'),
            lugar('3', 'Cerrado', 'https://melinails.com.ar/', estado='CLOSED_PERMANENTLY'),
        ])
        self.assertEqual([n['nombre'] for n in salida], ['Meli Nails', 'Barber King'])  # el cerrado repite la cuenta
        self.assertEqual(salida[0]['prioridad'], 'alta')
        self.assertTrue(salida[1]['prioridad'].startswith('baja (ya usa Booksy'))

    def test_cerrado(self):
        salida = self.armar([lugar('3', 'Cerrado', 'https://cortesana.com/', estado='CLOSED_PERMANENTLY')])
        self.assertEqual(salida[0]['prioridad'], 'descartar (cerrado)')

    def test_cadena_grande_baja_puntos(self):
        chico = self.armar([lugar('1', 'Chico', 'https://cortesana.com/', resenas=30)])[0]['puntos']
        grande = self.armar([lugar('1', 'Grande', 'https://cortesana.com/', resenas=900)])[0]['puntos']
        self.assertEqual(chico - grande, 2)

    def test_saltea_los_que_ya_estan_en_prospectos(self):
        salida = self.armar([lugar('2', 'Meli Nails', 'https://melinails.com.ar/')], excluidos={'meli.nails.nqn'})
        self.assertEqual(salida, [])

    def test_lee_las_cuentas_de_prospectos_md(self):
        excluidos = p.cargar_excluidos(p.PROSPECTOS_MD)
        self.assertIn('nails.esculpidas.nqn', excluidos)


class Planilla(unittest.TestCase):
    def test_csv_para_excel(self):
        salida = Prioridad().armar([lugar('2', 'Meli Nails', 'https://melinails.com.ar/')])
        with tempfile.TemporaryDirectory() as d:
            ruta = os.path.join(d, 'x.csv')
            p.guardar_csv(salida, ruta)
            with open(ruta, encoding='utf-8-sig') as f:
                filas = list(csv.reader(f, delimiter=';'))
        self.assertEqual(filas[0], p.COLUMNAS)
        self.assertEqual(filas[1][:3], ['alta', '@meli.nails.nqn', 'Meli Nails'])
        self.assertEqual(filas[1][6], '5492991234567')

    def test_modo_urls_sin_clave(self):
        with tempfile.TemporaryDirectory() as d:
            urls, out = os.path.join(d, 'webs.txt'), os.path.join(d, 'out.csv')
            with open(urls, 'w') as f:
                f.write('# comentario\nhttps://www.instagram.com/glowstudiobrc/\n\n')
            p.main(['--urls', urls, '--salida', out, '--excluir', ''])
            with open(out, encoding='utf-8-sig') as f:
                filas = list(csv.reader(f, delimiter=';'))
        self.assertEqual(filas[1][1], '@glowstudiobrc')


if __name__ == '__main__':
    unittest.main()
