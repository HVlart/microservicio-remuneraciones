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
  { codigo: 'C-004', razonSocial: 'ZZ PRUEBA CUATRO SPA', rut: '13131313-6' },
  { codigo: 'C-005', razonSocial: 'ZZ PRUEBA CINCO LIMITADA', rut: '14141414-3' },
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
  /** Estado final de cada fila (lo último que se escribió). */
  const estado: Record<string, { estado: string; mensaje?: string }> = {};
  let navegadoresAbiertos = 0;
  let navegadoresCerrados = 0;
  const deps = {
    crearSesion: async () => {
      navegadoresAbiertos += 1;
      return {
        browser: { close: async () => { navegadoresCerrados += 1; } },
        page: nubox.iniciarSesion(),
      };
    },
    subirArchivoDrive: async (nombre: string, buffer: Buffer, codigo: string, anio: number, mes: number) => {
      subidas.push({ nombre, buffer, codigo, anio, mes });
      return `drive-${nombre}`;
    },
    marcarExitoso: async (id: string) => { exitosos.push(id); estado[id] = { estado: 'exitoso' }; },
    marcarError: async (id: string, mensaje: string) => { errores.push({ id, mensaje }); estado[id] = { estado: 'error', mensaje }; },
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
  return {
    nubox, deps, subidas, exitosos, errores, estado,
    navegadores: () => ({ abiertos: navegadoresAbiertos, cerrados: navegadoresCerrados }),
  };
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

test('si Nubox no cambia de empresa, ese intento NO se sube; tras recuperar el formulario el reintento trae la empresa correcta', async () => {
  const { deps, subidas, errores, estado } = armar({ ignorarCambioDeEmpresa: true });
  const registros = [registro('C-001', 2026, 10), registro('C-002', 2026, 10)];

  const resumen = await procesarRegistros(registros, deps);

  // El primer intento de C-002 trajo el reporte de C-001: rechazado y sin subir.
  assert.equal(errores[0].id, 'C-002-2026-10');
  assert.match(errores[0].mensaje, /empresa/i);
  // Ningún archivo subido trae el encabezado de otra empresa.
  for (const s of subidas) assert.equal(rutDelArchivo(s.buffer), rutDe(s.codigo));
  assert.deepEqual(subidas.map((s) => s.codigo), ['C-001', 'C-002']);
  assert.equal(estado['C-002-2026-10'].estado, 'exitoso');
  assert.equal(resumen.exitosos, 2);
  assert.equal(resumen.errores, 0);
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

// ---------------------------------------------------------------------------
// Recuperación ante fallos de Nubox (antes del cron del 15-12-2026)
// ---------------------------------------------------------------------------

const lote = (...codigos: string[]) => codigos.map((c) => registro(c, 2026, 11));
const idDe = (codigo: string) => `${codigo}-2026-11`;

test('un timeout a mitad de lote no arrastra a los siguientes: se reabre el formulario y el fallido se reintenta al final', async () => {
  const { deps, subidas, estado, nubox, navegadores } = armar({ timeoutsAlGenerar: { 'C-002': 1 } });

  const resumen = await procesarRegistros(lote('C-001', 'C-002', 'C-003'), deps);

  assert.equal(estado[idDe('C-003')].estado, 'exitoso', 'C-003 quedó arrastrado por el timeout de C-002');
  assert.equal(estado[idDe('C-002')].estado, 'exitoso', 'C-002 no se reintentó al final');
  assert.deepEqual(nubox.descargas.map((d) => d.empresa), ['C-001', 'C-003', 'C-002']);
  for (const s of subidas) assert.equal(rutDelArchivo(s.buffer), rutDe(s.codigo));
  assert.equal(resumen.exitosos, 3);
  assert.equal(resumen.errores, 0);
  // Bastó con reabrir el formulario: una sola sesión.
  assert.equal(nubox.sesiones, 1);
  assert.ok(nubox.gotos.length >= 1, 'no volvió al inicio para reabrir el formulario');
  assert.deepEqual(navegadores(), { abiertos: 1, cerrados: 1 });
});

test('si reabrir el formulario falla, cierra la sesión, abre una nueva y sigue', async () => {
  const { deps, estado, nubox, navegadores } = armar({ timeoutsAlGenerar: { 'C-002': 1 }, gotoFalla: true });

  const resumen = await procesarRegistros(lote('C-001', 'C-002', 'C-003'), deps);

  assert.equal(nubox.sesiones, 2);
  assert.deepEqual(navegadores(), { abiertos: 2, cerrados: 2 });
  for (const c of ['C-001', 'C-002', 'C-003']) assert.equal(estado[idDe(c)].estado, 'exitoso', c);
  assert.equal(resumen.exitosos, 3);
});

test('si tampoco se puede abrir una sesión nueva, se detiene el lote y el resto queda en error con motivo', async () => {
  const { deps, estado, nubox } = armar({ timeoutsAlGenerar: { 'C-002': 1 }, gotoFalla: true });
  const crear = deps.crearSesion;
  let llamadas = 0;
  deps.crearSesion = async () => {
    llamadas += 1;
    if (llamadas > 1) throw new Error('No se pudo iniciar sesión en Nubox tras 3 intentos: Timeout');
    return crear();
  };

  const resumen = await procesarRegistros(lote('C-001', 'C-002', 'C-003'), deps);

  assert.equal(estado[idDe('C-001')].estado, 'exitoso');
  for (const c of ['C-002', 'C-003']) {
    assert.equal(estado[idDe(c)].estado, 'error');
    assert.match(estado[idDe(c)].mensaje!, /detenido.*recuperar/i);
  }
  assert.equal(nubox.intentosGenerar['C-003'], undefined);
  assert.equal(resumen.detenido, true);
});

test('un registro se reintenta una sola vez: si falla de nuevo queda en error', async () => {
  const { deps, estado, nubox, subidas } = armar({ timeoutsAlGenerar: { 'C-002': Infinity } });

  const resumen = await procesarRegistros(lote('C-001', 'C-002', 'C-003'), deps);

  assert.equal(nubox.intentosGenerar['C-002'], 2);
  assert.equal(estado[idDe('C-002')].estado, 'error');
  assert.match(estado[idDe('C-002')].mensaje!, /reintent/i);
  assert.match(estado[idDe('C-002')].mensaje!, /Timeout/);
  assert.equal(estado[idDe('C-001')].estado, 'exitoso');
  assert.equal(estado[idDe('C-003')].estado, 'exitoso');
  assert.ok(!subidas.some((s) => s.codigo === 'C-002'));
  assert.deepEqual([resumen.exitosos, resumen.errores], [2, 1]);
});

test('3 registros seguidos fallan aun después de recuperar: se detiene el lote y el resto queda en error con motivo', async () => {
  const siempre = { 'C-001': Infinity, 'C-002': Infinity, 'C-003': Infinity };
  const { deps, estado, nubox, subidas, navegadores } = armar({ timeoutsAlGenerar: siempre });

  const resumen = await procesarRegistros(lote('C-001', 'C-002', 'C-003', 'C-004', 'C-005'), deps);

  // Los 3 fallidos no se reintentan: el lote se detuvo.
  for (const c of ['C-001', 'C-002', 'C-003']) {
    assert.equal(nubox.intentosGenerar[c], 1, `${c} se intentó más de una vez`);
    assert.equal(estado[idDe(c)].estado, 'error');
    assert.match(estado[idDe(c)].mensaje!, /detenido/i);
  }
  // Los que no alcanzaron a procesarse quedan en error con motivo claro, sin tocar Nubox.
  for (const c of ['C-004', 'C-005']) {
    assert.equal(nubox.intentosGenerar[c], undefined, `${c} se procesó después de detener el lote`);
    assert.equal(estado[idDe(c)].estado, 'error');
    assert.match(estado[idDe(c)].mensaje!, /detenido.*3 registros seguidos/i);
  }
  assert.deepEqual(subidas, []);
  assert.deepEqual([resumen.procesados, resumen.exitosos, resumen.errores], [5, 0, 5]);
  assert.equal(resumen.detenido, true);
  const n = navegadores();
  assert.equal(n.abiertos, n.cerrados, 'quedó un navegador abierto');
});

test('fallos que no son seguidos no detienen el lote', async () => {
  const { deps, estado, nubox } = armar({ timeoutsAlGenerar: { 'C-001': Infinity, 'C-003': Infinity } });

  const resumen = await procesarRegistros(lote('C-001', 'C-002', 'C-003', 'C-004', 'C-005'), deps);

  assert.equal(resumen.detenido, false);
  for (const c of ['C-002', 'C-004', 'C-005']) assert.equal(estado[idDe(c)].estado, 'exitoso', c);
  for (const c of ['C-001', 'C-003']) {
    assert.equal(nubox.intentosGenerar[c], 2, `${c}: un intento y un reintento`);
    assert.equal(estado[idDe(c)].estado, 'error');
  }
});

test('el reintento también pasa por la verificación: un reporte de otra empresa nunca se sube', async () => {
  const { deps, estado, nubox, subidas } = armar({ contenidoDe: { 'C-002': 'C-001' } });

  await procesarRegistros(lote('C-001', 'C-002', 'C-003'), deps);

  assert.equal(nubox.intentosGenerar['C-002'], 2);
  assert.equal(estado[idDe('C-002')].estado, 'error');
  assert.match(estado[idDe('C-002')].mensaje!, /otra empresa/i);
  assert.deepEqual(subidas.map((s) => s.codigo), ['C-001', 'C-003']);
  for (const s of subidas) assert.equal(rutDelArchivo(s.buffer), rutDe(s.codigo));
});

test('si el primer registro falla al abrir el formulario, se recupera y sigue', async () => {
  // Visto en la reparación (26-11-2026): timeout en el botón «Costo Empresa».
  const { deps, estado } = armar({ timeoutsCostoEmpresa: 1 });

  const resumen = await procesarRegistros(lote('C-001', 'C-002'), deps);

  assert.equal(estado[idDe('C-001')].estado, 'exitoso');
  assert.equal(estado[idDe('C-002')].estado, 'exitoso');
  assert.equal(resumen.exitosos, 2);
});

test('sin datos del contribuyente es un error definitivo: no se reintenta ni cuenta como fallo de Nubox', async () => {
  const sinDatos = EMPRESAS.filter((e) => !['C-001', 'C-002', 'C-003'].includes(e.codigo));
  const { deps, estado, nubox } = armar({}, sinDatos);

  const resumen = await procesarRegistros(lote('C-001', 'C-002', 'C-003', 'C-004'), deps);

  assert.equal(resumen.detenido, false);
  assert.equal(estado[idDe('C-004')].estado, 'exitoso');
  for (const c of ['C-001', 'C-002', 'C-003']) {
    assert.equal(estado[idDe(c)].estado, 'error');
    assert.equal(nubox.intentosGenerar[c], undefined);
  }
});

// ---------------------------------------------------------------------------
// Tope de sesiones nuevas de Nubox por lote (sin contar el login inicial)
// ---------------------------------------------------------------------------

/** RUT ficticio con dígito verificador válido. */
function rutFicticio(cuerpo: number): string {
  let suma = 0;
  let factor = 2;
  for (const d of String(cuerpo).split('').reverse()) {
    suma += Number(d) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const dv = 11 - (suma % 11);
  return `${cuerpo}-${dv === 11 ? '0' : dv === 10 ? 'K' : dv}`;
}

/** 14 empresas ficticias C-101..C-114 (3 dígitos: ningún código es prefijo de otro). */
const MUCHAS: EmpresaFalsa[] = Array.from({ length: 14 }, (_, k) => ({
  codigo: `C-${101 + k}`,
  razonSocial: `ZZ PRUEBA TOPE ${101 + k} SPA`,
  rut: rutFicticio(20000000 + k * 1111),
}));
const codigos = (desde: number, hasta: number) =>
  MUCHAS.filter((e) => Number(e.codigo.slice(2)) >= desde && Number(e.codigo.slice(2)) <= hasta).map((e) => e.codigo);
/** Fallan las impares: los fallos nunca son seguidos (no salta el corte por 3 seguidos). */
const impares = (cods: string[], veces: number) =>
  Object.fromEntries(cods.filter((c) => Number(c.slice(2)) % 2 === 1).map((c) => [c, veces]));

test('tope de sesiones: 5 sesiones nuevas en un lote se permiten', async () => {
  const cods = codigos(101, 110);
  // Reabrir siempre falla: cada recuperación abre una sesión nueva. 5 fallos (101..109) -> 5 sesiones nuevas.
  const { deps, estado, nubox } = armar(
    { empresas: MUCHAS, gotoFalla: true, timeoutsAlGenerar: impares(cods, 1) },
    MUCHAS
  );

  const resumen = await procesarRegistros(lote(...cods), deps);

  assert.equal(resumen.detenido, false);
  assert.equal(nubox.sesiones, 1 + 5);
  for (const c of cods) assert.equal(estado[idDe(c)].estado, 'exitoso', c);
});

test('tope de sesiones: si se necesita una sexta sesión nueva, se detiene el lote y el resto queda en error con motivo', async () => {
  const cods = codigos(101, 114);
  const { deps, estado, nubox, subidas, navegadores } = armar(
    { empresas: MUCHAS, gotoFalla: true, timeoutsAlGenerar: impares(cods, Infinity) },
    MUCHAS
  );

  const resumen = await procesarRegistros(lote(...cods), deps);

  const MOTIVO = 'Lote detenido: se alcanzó el máximo de sesiones nuevas por lote';
  assert.equal(resumen.detenido, true);
  assert.equal(nubox.sesiones, 1 + 5, 'abrió más de 5 sesiones nuevas');
  // Antes del tope: las pares salieron bien (cada una con su sesión nueva).
  for (const c of ['C-102', 'C-104', 'C-106', 'C-108', 'C-110']) assert.equal(estado[idDe(c)].estado, 'exitoso', c);
  // C-111 falló y su recuperación necesitaba la sexta: de ahí en adelante no se procesa nada.
  for (const c of ['C-112', 'C-113', 'C-114']) {
    assert.equal(nubox.intentosGenerar[c], undefined, `${c} se procesó después del tope`);
    assert.equal(estado[idDe(c)].estado, 'error');
    assert.ok(estado[idDe(c)].mensaje!.startsWith(MOTIVO), estado[idDe(c)].mensaje);
  }
  // Los fallidos pendientes no se reintentan: quedan en error con el mismo motivo.
  for (const c of ['C-101', 'C-103', 'C-105', 'C-107', 'C-109', 'C-111']) {
    assert.equal(nubox.intentosGenerar[c], 1, `${c} se reintentó`);
    assert.equal(estado[idDe(c)].estado, 'error');
    assert.ok(estado[idDe(c)].mensaje!.startsWith(MOTIVO), estado[idDe(c)].mensaje);
  }
  assert.ok(subidas.every((s) => !s.codigo.match(/C-1(01|03|05|07|09|11|12|13|14)/)));
  assert.deepEqual([resumen.procesados, resumen.exitosos, resumen.errores], [14, 5, 9]);
  const n = navegadores();
  assert.equal(n.abiertos, n.cerrados, 'quedó un navegador abierto');
});
