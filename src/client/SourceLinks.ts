import { ClientEnv } from "./ClientEnv";

export const sourceRepositoryUrl =
  "https://github.com/mushroomlemonade/idlefront";

function deployedSourceRef(): string {
  try {
    const commit = ClientEnv.gitCommit().trim();
    if (/^[0-9a-f]{7,40}$/i.test(commit)) return commit;
  } catch {
    // Static previews may render before BOOTSTRAP_CONFIG exists.
  }
  return "main";
}

export function correspondingSourceUrl(): string {
  const ref = deployedSourceRef();
  return ref === "main"
    ? sourceRepositoryUrl
    : `${sourceRepositoryUrl}/tree/${ref}`;
}

export function sourceFileUrl(path: string): string {
  return `${sourceRepositoryUrl}/blob/${deployedSourceRef()}/${path}`;
}
