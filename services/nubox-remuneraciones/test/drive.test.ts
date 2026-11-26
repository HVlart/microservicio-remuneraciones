/**
 * Reemplazo de un libro existente en Drive: nunca con files.update del contenido
 * (la versión anterior queda en el historial de versiones del archivo). Se crea
 * un archivo nuevo y el anterior va a la papelera. Las búsquedas excluyen la
 * papelera. (Incidente libros 26-11-2026.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { drive_v3 } from 'googleapis';
import { subirArchivoDrive } from '../src/drive';

interface Llamada { metodo: string; params: any }

function driveFalso(existentes: { [nombre: string]: string[] } = {}, opciones: { fallarPapelera?: boolean } = {}) {
  const llamadas: Llamada[] = [];
  let n = 0;
  const drive = {
    files: {
      list: async (params: any) => {
        llamadas.push({ metodo: 'list', params });
        const nombre = /name = '([^']+)'/.exec(params.q)?.[1] ?? '';
        if (params.q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return { data: { files: [{ id: `carpeta-${nombre}`, name: nombre }] } };
        }
        return { data: { files: (existentes[nombre] ?? []).map((id) => ({ id, name: nombre })) } };
      },
      create: async (params: any) => {
        llamadas.push({ metodo: 'create', params });
        return { data: { id: `nuevo-${++n}` } };
      },
      update: async (params: any) => {
        llamadas.push({ metodo: 'update', params });
        if (opciones.fallarPapelera) throw new Error('403 insufficientFilePermissions');
        return { data: { id: params.fileId } };
      },
      delete: async (params: any) => {
        llamadas.push({ metodo: 'delete', params });
        return { data: {} };
      },
    },
  };
  return { drive: drive as unknown as drive_v3.Drive, llamadas };
}

const NOMBRE = 'C-001_Libro_Remuneraciones_2026_10.xlsx';
process.env.DRIVE_FOLDER_ID = 'raiz';

test('toda búsqueda en Drive excluye la papelera', async () => {
  const { drive, llamadas } = driveFalso({ [NOMBRE]: ['viejo-1'] });
  await subirArchivoDrive(NOMBRE, Buffer.from('x'), 'C-001', 2026, 10, drive);
  const listas = llamadas.filter((l) => l.metodo === 'list');
  assert.ok(listas.length >= 3);
  for (const l of listas) assert.match(l.params.q, /trashed = false/);
});

test('si el archivo ya existe: crea uno nuevo y manda el anterior a la papelera; nunca reemplaza el contenido', async () => {
  const { drive, llamadas } = driveFalso({ [NOMBRE]: ['viejo-1', 'viejo-2'] });

  const id = await subirArchivoDrive(NOMBRE, Buffer.from('x'), 'C-001', 2026, 10, drive);

  assert.equal(id, 'nuevo-1');
  const creados = llamadas.filter((l) => l.metodo === 'create' && l.params.requestBody?.name === NOMBRE);
  assert.equal(creados.length, 1);
  assert.deepEqual(creados[0].params.requestBody.parents, ['carpeta-2026']);
  const updates = llamadas.filter((l) => l.metodo === 'update');
  assert.ok(updates.every((u) => u.params.media === undefined), 'files.update con contenido (deja la versión vieja en el historial)');
  assert.deepEqual(updates.map((u) => [u.params.fileId, u.params.requestBody?.trashed]), [['viejo-1', true], ['viejo-2', true]]);
  // El nuevo se crea ANTES de mandar los anteriores a la papelera.
  const iCrear = llamadas.indexOf(creados[0]);
  assert.ok(updates.every((u) => llamadas.indexOf(u) > iCrear));
});

test('si no existe: solo crea', async () => {
  const { drive, llamadas } = driveFalso();
  await subirArchivoDrive(NOMBRE, Buffer.from('x'), 'C-001', 2026, 10, drive);
  assert.equal(llamadas.filter((l) => l.metodo === 'update' || l.metodo === 'delete').length, 0);
  assert.equal(llamadas.filter((l) => l.metodo === 'create').length, 1);
});

test('si no se puede mandar el anterior a la papelera, falla (el registro queda en error)', async () => {
  const { drive } = driveFalso({ [NOMBRE]: ['viejo-1'] }, { fallarPapelera: true });
  await assert.rejects(
    subirArchivoDrive(NOMBRE, Buffer.from('x'), 'C-001', 2026, 10, drive),
    /papelera/
  );
});
