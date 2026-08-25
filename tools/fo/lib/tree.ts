import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * A directory as a map from POSIX-style relative path to file content.
 *
 * `fo config` compares three trees at once - the running pod, the stock image,
 * and the repo - so they are read into memory rather than diffed on disk. They
 * are small (IDM's conf is ~60 files, AM's FBC ~220) and the alternative is
 * three temp directories and a permissions problem.
 */
export type Tree = Map<string, Buffer>;

export function readTree(dir: string): Tree {
  const out: Tree = new Map();
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(relative(dir, p).split(sep).join("/"), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

export function writeTree(dir: string, tree: Tree): void {
  for (const [rel, content] of tree) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

export type TreeDiff = {
  /** In `to` but not `from`. */
  added: string[];
  /** In both, different content. */
  changed: string[];
  /** In `from` but not `to`. */
  removed: string[];
};

export function diffTrees(from: Tree, to: Tree): TreeDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [rel, content] of to) {
    const before = from.get(rel);
    if (before === undefined) added.push(rel);
    else if (!before.equals(content)) changed.push(rel);
  }
  for (const rel of from.keys()) if (!to.has(rel)) removed.push(rel);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

export function isEmptyDiff(d: TreeDiff): boolean {
  return d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
}

/** True if the bytes look like text, so a diff can be rendered rather than "binary". */
export function isText(b: Buffer): boolean {
  return !b.subarray(0, 8000).includes(0);
}

/** Total file count, for the "n files" lines the commands print. */
export function treeSize(t: Tree): number {
  return t.size;
}

/**
 * Read a tree, but only the paths under `prefix`, with the prefix stripped.
 * The pod and image tarballs both arrive rooted at `conf/` or `config/`.
 */
export function subtree(t: Tree, prefix: string): Tree {
  const p = prefix.endsWith("/") ? prefix : prefix + "/";
  const out: Tree = new Map();
  for (const [rel, content] of t) {
    if (rel.startsWith(p)) out.set(rel.slice(p.length), content);
  }
  return out;
}
