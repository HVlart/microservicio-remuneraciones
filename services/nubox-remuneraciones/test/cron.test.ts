import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { contribuyentesParaCron } from '../src/cron';

/** Cliente falso que registra la cadena de filtros de cada consulta. */
function clienteFalso(tablas: Record<string, { data: unknown; error: unknown }>) {
  const consultas: Record<string, Array<[string, ...unknown[]]>> = {};
  const cliente = {
    from(tabla: string) {
      const pasos: Array<[string, ...unknown[]]> = [];
      consultas[tabla] = pasos;
      const q: any = {
        then: (ok: any, mal: any) => Promise.resolve(tablas[tabla]).then(ok, mal),
      };
      for (const m of ['select', 'eq', 'contains', 'order', 'not', 'or', 'is']) {
        q[m] = (...a: unknown[]) => { pasos.push([m, ...a]); return q; };
      }
      return q;
    },
  };
  return { cliente: cliente as unknown as SupabaseClient, consultas };
}

const EMPRESAS = [
  { id: 'a', numero_cliente: 'C-001', razon_social: 'ZZ UNO' },
  { id: 'p', numero_cliente: 'C-002', razon_social: 'ZZ PRUEBA' },
  { id: 'b', numero_cliente: 'C-003', razon_social: 'ZZ TRES' },
];

test('lote del cron: oficiales, activas, con remuneraciones, ordenadas por numero_cliente y sin las de prueba', async () => {
  const { cliente, consultas } = clienteFalso({
    contribuyentes_prueba: { data: [{ contribuyente_id: 'p' }], error: null },
    contribuyentes: { data: EMPRESAS, error: null },
  });

  const lote = await contribuyentesParaCron(cliente);

  assert.deepEqual(lote.map((c) => c.numero_cliente), ['C-001', 'C-003']);
  const pasos = consultas.contribuyentes;
  assert.ok(pasos.some((p) => p[0] === 'eq' && p[1] === 'estado_cliente' && p[2] === 'oficial'));
  assert.ok(pasos.some((p) => p[0] === 'eq' && p[1] === 'activo' && p[2] === true));
  assert.ok(pasos.some((p) => p[0] === 'contains' && p[1] === 'servicios'));
  assert.ok(pasos.some((p) => p[0] === 'order' && p[1] === 'numero_cliente'));
});

test('falla cerrado si no puede leer contribuyentes_prueba', async () => {
  const { cliente } = clienteFalso({
    contribuyentes_prueba: { data: null, error: { message: 'permission denied' } },
    contribuyentes: { data: EMPRESAS, error: null },
  });
  await assert.rejects(contribuyentesParaCron(cliente), /contribuyentes_prueba/);
});
