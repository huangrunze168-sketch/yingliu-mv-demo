export type PersistedProjectAsset = {
  id: string;
  projectId: string;
  key: 'song' | 'lyrics' | 'portrait' | 'reference' | 'voice';
  position: number;
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
};

type PersistableAssets = {
  song: File | null;
  lyrics: File | null;
  portrait: File[];
  reference: File | null;
  voice: File | null;
};

const DB_NAME = 'yingliu-project-assets';
const DB_VERSION = 1;
const STORE_NAME = 'assets';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      store.createIndex('projectId', 'projectId', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开项目素材存储'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('项目素材保存失败'));
    transaction.onabort = () => reject(transaction.error || new Error('项目素材保存已取消'));
  });
}

function assetRecord(projectId: string, key: PersistedProjectAsset['key'], file: File, position = 0): PersistedProjectAsset {
  return {
    id: `${projectId}:${key}:${position}`,
    projectId,
    key,
    position,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    blob: file,
  };
}

export async function saveProjectAssets(projectId: string, assets: PersistableAssets): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const cursorRequest = store.index('projectId').openKeyCursor(IDBKeyRange.only(projectId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
        return;
      }
      const records = [
        assets.song ? assetRecord(projectId, 'song', assets.song) : null,
        assets.lyrics ? assetRecord(projectId, 'lyrics', assets.lyrics) : null,
        ...assets.portrait.map((file, index) => assetRecord(projectId, 'portrait', file, index)),
        assets.reference ? assetRecord(projectId, 'reference', assets.reference) : null,
        assets.voice ? assetRecord(projectId, 'voice', assets.voice) : null,
      ].filter((item): item is PersistedProjectAsset => Boolean(item));
      records.forEach(record => store.put(record));
    };
    cursorRequest.onerror = () => transaction.abort();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function loadProjectAssets(projectId: string): Promise<PersistedProjectAsset[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).index('projectId').getAll(projectId);
      request.onsuccess = () => resolve((request.result as PersistedProjectAsset[]).sort((left, right) => left.position - right.position));
      request.onerror = () => reject(request.error || new Error('项目素材读取失败'));
    });
  } finally {
    database.close();
  }
}

export async function deleteProjectAssets(projectId: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.index('projectId').openKeyCursor(IDBKeyRange.only(projectId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => transaction.abort();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
