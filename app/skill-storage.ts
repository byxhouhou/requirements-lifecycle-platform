import type { LocalSkill } from "./skill-utils";

const DB = "reqflow-skill-library-v1";
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("skills", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法打开本机 Skill 存储"));
    request.onblocked = () => reject(new Error("Skill 存储正被其他窗口占用，请关闭其他窗口后重试"));
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("skills", mode), request = run(tx.objectStore("skills"));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = () => { db.close(); reject(new Error("Skill 存储失败，请检查本机存储空间和权限")); };
    tx.onabort = () => { db.close(); reject(new Error("Skill 存储操作未完成")); };
  });
}
export const readSkills = () => transaction<LocalSkill[]>("readonly", store => store.getAll());
export const saveSkill = (skill: LocalSkill) => transaction<IDBValidKey>("readwrite", store => store.put(skill));
export const deleteSkill = (id: string) => transaction<undefined>("readwrite", store => store.delete(id));
