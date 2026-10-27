import { useSyncExternalStore } from 'react';
type State = { activeProjectId?: string; selectedSection: string; rightPanel: boolean; commandPaletteOpen: boolean };
let state: State = { selectedSection: 'overview', rightPanel: true, commandPaletteOpen: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
export const uiStore = { get: () => state, set: (patch: Partial<State>) => { state = { ...state, ...patch }; emit(); }, subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); } };
export const useUiStore = () => useSyncExternalStore(uiStore.subscribe, uiStore.get, uiStore.get);
