const configured = import.meta.env.VITE_TREE_DATA_BASE_URL?.trim();

export function treeDataUrl(path: string) {
  const base = configured || import.meta.env.BASE_URL;
  return new URL(path.replace(/^\/+/, ''), new URL(base, window.location.href)).href;
}
