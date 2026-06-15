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

export async function actualizarEstadoExtraccion(
  id: string,
  estado: string,
  mensajeError?: string
): Promise<void> {
  const datos: Record<string, unknown> = { estado };

  if (mensajeError !== undefined) {
    datos.mensaje_error = mensajeError;
  }

  const { error } = await supabase
    .from('extracciones_log')
    .update(datos)
    .eq('id', id);

  if (error) {
    throw new Error(
      `Error al actualizar extracciones_log (id=${id}): ${error.message}`
    );
  }
}
