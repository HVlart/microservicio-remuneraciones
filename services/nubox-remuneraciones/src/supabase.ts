import { createClient, SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    'Faltan variables de entorno SUPABASE_URL y/o SUPABASE_SERVICE_KEY'
  );
}

export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey,
  {
    realtime: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transport: ws as any,
    },
  }
);

export interface OpcionesActualizacion {
  mensajeError?: string;
  nombreArchivo?: string;
}

export async function actualizarEstadoExtraccion(
  id: string,
  estado: string,
  opciones: OpcionesActualizacion = {}
): Promise<void> {
  const datos: Record<string, unknown> = { estado };

  if (opciones.mensajeError !== undefined) {
    datos.mensaje_error = opciones.mensajeError;
  }
  if (opciones.nombreArchivo !== undefined) {
    datos.nombre_archivo = opciones.nombreArchivo;
  }

  console.log(
    `[supabase] Actualizando extracciones_log id=${id} -> estado='${estado}'`,
    datos
  );

  // .select() es CLAVE: permite saber cuántas filas se actualizaron realmente.
  // Sin esto, un UPDATE que no encuentra la fila devuelve error=null y la fila
  // queda sin cambios de forma silenciosa.
  const { data, error } = await supabase
    .from('extracciones_log')
    .update(datos)
    .eq('id', id)
    .select('id');

  if (error) {
    console.error(
      `[supabase] ERROR al actualizar extracciones_log (id=${id}):`,
      error
    );
    throw new Error(
      `Error al actualizar extracciones_log (id=${id}): ${error.message}`
    );
  }

  if (!data || data.length === 0) {
    const msg = `[supabase] ADVERTENCIA: el UPDATE no afectó ninguna fila (id=${id}). ¿Existe el registro y el id es correcto?`;
    console.error(msg);
    throw new Error(
      `El UPDATE de extracciones_log no afectó ninguna fila (id=${id})`
    );
  }

  console.log(
    `[supabase] OK: extracciones_log id=${id} actualizado a estado='${estado}' (${data.length} fila/s)`
  );
}
