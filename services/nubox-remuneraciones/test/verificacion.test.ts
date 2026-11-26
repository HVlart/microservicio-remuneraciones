import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { verificarReporte, ErrorVerificacion, EmpresaEsperada } from '../src/verificacion';
import { crearXlsxCostoEmpresa } from './nubox-falso';

const UNO: EmpresaEsperada = { codigo: 'C-001', razonSocial: 'ZZ PRUEBA UNO SPA', rut: '11111111', dv: '1' };
const xlsxDe = (filas: unknown[][], hoja = 'Reporte Costo Empresa'): Buffer => {
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), hoja);
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};
const rechaza = (fn: () => void, patron: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof ErrorVerificacion && patron.test(e.message));

test('acepta el reporte de la empresa esperada', () => {
  verificarReporte(crearXlsxCostoEmpresa({ codigo: 'C-001', razonSocial: UNO.razonSocial, rut: '11111111-1' }, 2026, 10), UNO);
});

test('acepta el RUT con puntos y el dígito verificador k en minúscula', () => {
  verificarReporte(xlsxDe([['X'], ['11.111.111-1'], ['DIR'], ['Nombre']]), UNO);
  verificarReporte(xlsxDe([['X'], ['7.654.321-k'], ['DIR'], ['Nombre']]), { ...UNO, rut: '7654321', dv: 'K' });
});

test('rechaza el reporte de otra empresa (RUT distinto)', () => {
  const otro = crearXlsxCostoEmpresa({ codigo: 'C-002', razonSocial: 'ZZ PRUEBA DOS LIMITADA', rut: '12345678-5' }, 2026, 10);
  rechaza(() => verificarReporte(otro, UNO), /otra empresa/);
});

test('rechaza aunque la razón social calce si el RUT es otro', () => {
  rechaza(() => verificarReporte(xlsxDe([[UNO.razonSocial], ['12345678-5'], ['DIR'], ['Nombre']]), UNO), /otra empresa/);
});

test('no confunde el RUT de un trabajador (bajo «Nombre») con el de la empresa', () => {
  // Empresa correcta arriba; trabajador con otro RUT abajo: debe aceptarse.
  verificarReporte(xlsxDe([[UNO.razonSocial], ['11111111-1'], ['DIR'], ['Nombre', 'RUT'], ['TRAB', '12345678-5']]), UNO);
  // Encabezado sin RUT de empresa y un RUT de trabajador = el de la empresa: no basta.
  rechaza(() => verificarReporte(xlsxDe([['OTRA EMPRESA'], ['DIR'], ['Nombre', 'RUT'], ['TRAB', '11111111-1']]), UNO), /No se pudo comprobar/);
});

test('sin RUT en el encabezado: acepta solo la razón social exacta (sin tildes ni puntuación)', () => {
  verificarReporte(xlsxDe([['ZZ Prueba Uno, SpA.'], ['DIR'], ['Nombre']]), { ...UNO, razonSocial: 'ZZ PRUEBA UNO SPA' });
  rechaza(() => verificarReporte(xlsxDe([['ZZ PRUEBA UNO SPA Y COMPAÑIA'], ['DIR'], ['Nombre']]), UNO), /No se pudo comprobar/);
});

test('rechaza otro tipo de reporte (nombre de hoja)', () => {
  const buf = crearXlsxCostoEmpresa({ codigo: 'C-001', razonSocial: UNO.razonSocial, rut: '11111111-1' }, 2026, 10, 'Libro de Remuneraciones');
  rechaza(() => verificarReporte(buf, UNO), /Tipo de reporte/);
});

test('rechaza un archivo que no es xlsx', () => {
  rechaza(() => verificarReporte(Buffer.from('<html>sesión expirada</html>'), UNO), /./);
});
