import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

export async function actualizarEstadoExtraccion(
  id: string,
  estado: string,
  mensajeError?: string
): Promise<void> {
  const datos: Record<string, unknown> = {
    estado,
    actualizado_at: new Date().toISOString(),
  };

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
