import type { SupabaseClient } from '@supabase/supabase-js';

export interface ContribuyenteCron {
  id: string;
  numero_cliente: string;
  razon_social: string;
}

/**
 * Empresas del lote automático del día 15: oficiales, activas, con el servicio
 * de remuneraciones y que no sean de prueba (contribuyentes_prueba, incluidas
 * las de validación: los libros reales las excluyen todas).
 *
 * ORDER BY numero_cliente: sin orden, Postgres devuelve el orden físico, que
 * cambia cuando se actualiza una fila (por eso el 15-11 cambió la primera
 * empresa del lote; incidente 26-11-2026).
 *
 * Falla cerrado: si no puede leer la marca de prueba, lanza y no hay lote.
 */
export async function contribuyentesParaCron(
  cliente: SupabaseClient
): Promise<ContribuyenteCron[]> {
  const { data: prueba, error: errorPrueba } = await cliente
    .from('contribuyentes_prueba')
    .select('contribuyente_id');
  if (errorPrueba || !prueba) {
    throw new Error(
      `No se pudo leer contribuyentes_prueba (el lote automático no corre sin esa marca): ${errorPrueba?.message ?? 'sin datos'}`
    );
  }
  const excluidas = new Set(prueba.map((p: { contribuyente_id: string }) => p.contribuyente_id));

  const { data, error } = await cliente
    .from('contribuyentes')
    .select('id, numero_cliente, razon_social')
    // Los provisionales y descartados no participan en procesos (creacion de empresas).
    .eq('estado_cliente', 'oficial')
    .eq('activo', true)
    .contains('servicios', ['remuneraciones'])
    .order('numero_cliente', { ascending: true });
  if (error) {
    throw new Error(`Error consultando contribuyentes: ${error.message}`);
  }

  return ((data ?? []) as ContribuyenteCron[]).filter((c) => !excluidas.has(c.id));
}
