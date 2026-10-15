"""Pruebas sin red de buscar_instagram.py (resultados de DuckDuckGo reales, guardados).  python3 -m unittest"""

import csv
import os
import tempfile
import unittest

import buscar_instagram as b


def resultado(cuenta, titulo, texto):
    href = f'//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2F{cuenta}%2F&rut=abc'
    return f'<div class="result"><a class="result__a" href="{href}">{titulo}</a><a class="result__snippet">{texto}</a></div>'


PAGINA = '<html><body>' + ''.join([
    resultado('bdananails', 'Nails Bariloche (@bdananails) • Instagram photos and videos',
              '430 Followers, 455 Following, 22 Posts - Nails Bariloche (@bdananails) on Instagram: "Danna 💅 Semipermanente, Capping y Soft gel. Reserva tu turno ⤵️"'),
    resultado('nailsbariloche', 'Nails Bariloche (@nailsbariloche)',
              '3,049 Followers, 3,156 Following, 339 Posts - See Instagram photos and videos from Nails Bariloche (@nailsbariloche)'),
    resultado('barbara_rcb', 'Barbara (@barbara_rcb)', 'Maestra y psicopedagoga. Bariloche. 27 followers'),
    resultado('nails.cordoba', 'Nails Córdoba (@nails.cordoba)', '5,000 Followers - on Instagram: "Uñas en Córdoba"'),
    resultado('insumos.brc', 'Insumos nails brc', '12K Followers - on Instagram: "Venta de insumos para uñas. Bariloche"'),
    '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Fp%2FDdRq%2F">post</a></div>',
]) + '</body></html>'


class Lectura(unittest.TestCase):
    def test_resultados_saca_cuentas_y_no_publicaciones(self):
        r = b.resultados(PAGINA)
        self.assertEqual([x['cuenta'] for x in r], ['bdananails', 'nailsbariloche', 'barbara_rcb', 'nails.cordoba', 'insumos.brc'])

    def test_seguidores(self):
        self.assertEqual(b.seguidores('3,049 Followers, 3,156 Following'), 3049)
        self.assertEqual(b.seguidores('1.234 seguidores'), 1234)
        self.assertEqual(b.seguidores('12K Followers'), 12000)
        self.assertEqual(b.seguidores('1.2K Followers'), 1200)
        self.assertIsNone(b.seguidores('sin datos'))

    def test_bio(self):
        self.assertEqual(b.bio('430 Followers - X on Instagram: "Semi y soft gel. Reserva tu turno"'), 'Semi y soft gel. Reserva tu turno')
        self.assertEqual(b.bio('140 Followers, 260 Following, 270 Posts - See Instagram photos and videos from X'), '')


class Calificar(unittest.TestCase):
    def setUp(self):
        self.r = {x['cuenta']: x for x in b.resultados(PAGINA)}

    def test_filtros(self):
        self.assertTrue(b.es_de_la_ciudad(self.r['bdananails'], 'Bariloche', 'brc'))
        self.assertFalse(b.es_de_la_ciudad(self.r['nails.cordoba'], 'Bariloche', 'brc'))
        self.assertTrue(b.es_de_la_ciudad(self.r['insumos.brc'], 'Bariloche', 'brc'))
        self.assertFalse(b.es_del_rubro(self.r['barbara_rcb'], 'unas'))
        self.assertTrue(b.es_del_rubro(self.r['bdananails'], 'unas'))

    def test_prioridad(self):
        self.assertEqual(b.calificar(self.r['bdananails'])['prioridad'], 'alta')  # reserva por mensaje + 430 seguidores
        self.assertEqual(b.calificar(self.r['nailsbariloche'])['prioridad'], 'media')  # punto dulce, sin bio
        self.assertTrue(b.calificar(self.r['insumos.brc'])['prioridad'].startswith('baja (vende insumos'))


class Main(unittest.TestCase):
    def test_junta_filtra_y_guarda(self):
        consultas = []

        def buscar(consulta):
            consultas.append(consulta)
            return 200, b.resultados(PAGINA)
        with tempfile.TemporaryDirectory() as d:
            salida = os.path.join(d, 'x.csv')
            cuentas = b.main(['--ciudad', 'Bariloche', '--codigo', 'brc', '--rubro', 'unas', '--max', '2', '--salida', salida,
                              '--excluir', ''], buscar=buscar, pausa=0)
            filas = list(csv.reader(open(salida, encoding='utf-8-sig'), delimiter=';'))
        self.assertEqual(consultas, ['site:instagram.com nails Bariloche'])  # con 2 ya alcanza
        self.assertEqual([c['cuenta'] for c in cuentas], ['bdananails', 'nailsbariloche'])
        self.assertEqual(filas[1][:3], ['alta', '@bdananails', '430'])

    def test_corta_si_pide_verificacion(self):
        with tempfile.TemporaryDirectory() as d:
            cuentas = b.main(['--ciudad', 'Bariloche', '--salida', os.path.join(d, 'x.csv'), '--excluir', ''],
                             buscar=lambda c: (202, []), pausa=0)
        self.assertEqual(cuentas, [])


if __name__ == '__main__':
    unittest.main()
