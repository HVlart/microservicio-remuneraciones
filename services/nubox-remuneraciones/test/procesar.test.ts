/**
 * Incidente 26-11-2026: en un lote con varias empresas, procesarRegistros()
 * solo elegía la empresa en Nubox para el primer registro; los demás subían a
 * Drive el reporte de la primera empresa con el nombre de la suya.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { procesarRegistros, RegistroExtraccion } from '../src/procesar';
import { NuboxFalso, EmpresaFalsa, OpcionesNuboxFalso } from './nubox-falso';

const EMPRESAS: EmpresaFalsa[] = [
  { codigo: 'C-001', razonSocial: 'ZZ PRUEBA UNO SPA', rut: '11111111-1' },
  { codigo: 'C-002', razonSocial: 'ZZ PRUEBA DOS LIMITADA', rut: '12345678-5' },
  { codigo: 'C-003', razonSocial: 'ZZ PRUEBA TRES SA', rut: '7654321-K' },
];

function registro(codigo: string, anio: number, mes: number): RegistroExtraccion {
  return {
    id: `${codigo}-${anio}-${mes}`,
    contribuyente_id: `uuid-${codigo}`,
    codigo_cliente: codigo,
    nombre_cliente: EMPRESAS.find((e) => e.codigo === codigo)?.razonSocial ?? '',
    periodo_anio: anio,
    periodo_mes: mes,
  };
}

interface Subida { nombre: string; buffer: Buffer; codigo: string; anio: number; mes: number }

function armar(opciones: Partial<OpcionesNuboxFalso> = {}, contribuyentes: EmpresaFalsa[] = EMPRESAS) {
  const nubox = new NuboxFalso({ empresas: EMPRESAS, ...opciones });
  const subidas: Subida[] = [];
  const exitosos: string[] = [];
  const errores: Array<{ id: string; mensaje: string }> = [];
  let navegadorCerrado = false;
  const deps = {
    crearSesion: async () => ({
      browser: { close: async () => { navegadorCerrado = true; } },
      page: nubox.pagina(),
    }),
    subirArchivoDrive: async (nombre: string, buffer: Buffer, codigo: string, anio: number, mes: number) => {
      subidas.push({ nombre, buffer, codigo, anio, mes });
      return `drive-${nombre}`;
    },
    marcarExitoso: async (id: string) => { exitosos.push(id); },
    marcarError: async (id: string, mensaje: string) => { errores.push({ id, mensaje }); },
    esperar: async () => undefined,
    permitirMultiempresa: true,
    // Lo que la base dice de cada contribuyente (rut = cuerpo, dv aparte).
    obtenerEmpresa: async (r: RegistroExtraccion) => {
      const e = contribuyentes.find((c) => `uuid-${c.codigo}` === r.contribuyente_id);
      if (!e) return null;
      const [rut, dv] = e.rut.split('-');
      return { codigo: e.codigo, razonSocial: e.razonSocial, rut, dv };
    },
  };
  return { nubox, deps, subidas, exitosos, errores, cerrado: () => navegadorCerrado };
}

/** RUT del encabezado (fila 2) del xlsx subido. */
function rutDelArchivo(buffer: Buffer): string {
  const libro = XLSX.read(buffer, { type: 'buffer' });
  const filas = XLSX.utils.sheet_to_json<string[]>(libro.Sheets[libro.SheetNames[0]], { header: 1 });
  return String(filas[1][0]);
}

const rutDe = (codigo: string) => EMPRESAS.find((e) => e.codigo === codigo)!.rut;

test('lote de tres empresas: cada libro subido trae el encabezado de su propia empresa', async () => {
  const { deps, subidas, exitosos, errores, nubox } = armar();
  const registros = [registro('C-001', 2026, 10), registro('C-002', 2026, 10), registro('C-003', 2026, 10)];

  const resumen = await procesarRegistros(registros, deps);

  assert.deepEqual(errores, []);
  assert.equal(resumen.exitosos, 3);
  assert.deepEqual(nubox.seleccionesEmpresa, ['C-001', 'C-002', 'C-003']);
  assert.deepEqual(exitosos, registros.map((r) => r.id));
  for (const s of subidas) {
    assert.equal(rutDelArchivo(s.buffer), rutDe(s.codigo), `${s.nombre} trae el RUT de otra empresa`);
  }
});

test('si Nubox no cambia de empresa, el registro queda en error y NO se sube a Drive', async () => {
  const { deps, subidas, exitosos, errores } = armar({ ignorarCambioDeEmpresa: true });
  const registros = [registro('C-001', 2026, 10), registro('C-002', 2026, 10)];

  const resumen = await procesarRegistros(registros, deps);

  assert.deepEqual(subidas.map((s) => s.codigo), ['C-001']);
  assert.deepEqual(exitosos, ['C-001-2026-10']);
  assert.equal(resumen.errores, 1);
  assert.equal(errores[0].id, 'C-002-2026-10');
  assert.match(errores[0].mensaje, /empresa/i);
});

test('un reporte de otro tipo queda en error y NO se sube a Drive', async () => {
  const { deps, subidas, errores } = armar({ nombreHoja: 'Libro de Vacaciones' });

  const resumen = await procesarRegistros([registro('C-001', 2026, 10)], deps);

  assert.deepEqual(subidas, []);
  assert.equal(resumen.errores, 1);
  assert.match(errores[0].mensaje, /tipo de reporte/i);
});

test('sin datos de la empresa en contribuyentes no se puede verificar: error y NO se sube', async () => {
  const { deps, subidas, errores } = armar({}, EMPRESAS.filter((e) => e.codigo !== 'C-002'));

  await procesarRegistros([registro('C-002', 2026, 10)], deps);

  assert.deepEqual(subidas, []);
  assert.equal(errores.length, 1);
});

test('una empresa, varios meses: se suben todos con su período (regresión)', async () => {
  const { deps, subidas, errores, nubox } = armar();
  const registros = [registro('C-002', 2025, 11), registro('C-002', 2025, 12), registro('C-002', 2026, 1)];

  const resumen = await procesarRegistros(registros, deps);

  assert.deepEqual(errores, []);
  assert.equal(resumen.exitosos, 3);
  assert.deepEqual(nubox.descargas, [
    { empresa: 'C-002', anio: 2025, mes: 11 },
    { empresa: 'C-002', anio: 2025, mes: 12 },
    { empresa: 'C-002', anio: 2026, mes: 1 },
  ]);
  assert.ok(subidas.every((s) => rutDelArchivo(s.buffer) === rutDe('C-002')));
});

test('contención: sin permitirMultiempresa, un lote de dos empresas no abre Nubox ni sube nada', async () => {
  const { deps, subidas, errores, nubox } = armar();

  await procesarRegistros([registro('C-001', 2026, 10), registro('C-002', 2026, 10)], {
    ...deps,
    permitirMultiempresa: false,
  });

  assert.deepEqual(subidas, []);
  assert.equal(errores.length, 2);
  assert.equal(nubox.pantalla, 'inicio');
});
