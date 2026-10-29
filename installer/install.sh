#!/usr/bin/env bash
# macOS, Linux and Android/Termux. No Wrangler or native npm packages.
set -euo pipefail
trap 'printf "\nSetup stopped. Check your connection and try again.\n" >&2' ERR
release='https://github.com/DarkPoesidon/WIHM-Cloudflare/releases/latest/download'
cache_root="${HOME:?}/.wihm-cloudflare"
mkdir -p "$cache_root"
chmod 700 "$cache_root"

is_termux=false
if [[ -n "${TERMUX_VERSION:-}" || "${PREFIX:-}" == /data/data/com.termux/* ]]; then
  is_termux=true
  printf 'Preparing Termux packages...\n'
  # Termux does not support partial upgrades. Use apt directly so this also
  # repairs an old curl/OpenSSL mismatch before pkg's curl-based mirror check.
  apt-get update
  apt-get -y -o Dpkg::Options::=--force-confold dist-upgrade
  apt-get install -y curl tar termux-tools
  if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
    apt-get install -y nodejs-lts
  fi
fi
if ! command -v curl >/dev/null; then
  printf 'curl is required. On Ubuntu/Debian: sudo apt install curl ca-certificates\n' >&2
  exit 1
fi
download() { curl --fail --show-error --silent --location --retry 2 --connect-timeout 20 --max-time 600 --proto '=https' --tlsv1.2 "$1" -o "$2"; }
verify() {
  local file="$1" manifest="$2" name="$3" expected actual
  expected=$(awk -v name="$name" '$2 == name || $2 == "*"name {print $1; exit}' "$manifest")
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { printf 'Missing download checksum.\n' >&2; return 1; }
  if command -v sha256sum >/dev/null; then actual=$(sha256sum "$file"); else actual=$(shasum -a 256 "$file"); fi
  [[ "${actual%% *}" == "$expected" ]] || { printf 'Download checksum does not match. Run setup again.\n' >&2; return 1; }
}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
package_root="$script_dir"
if [[ ! -f "$package_root/payload/worker.mjs" ]]; then
  download_root=$(mktemp -d "$cache_root/download-XXXXXXXX")
  printf 'Downloading WIHM Installer...\n'
  download "$release/wihm-installer.tar.gz" "$download_root/wihm-installer.tar.gz"
  download "$release/SHA256SUMS" "$download_root/SHA256SUMS"
  verify "$download_root/wihm-installer.tar.gz" "$download_root/SHA256SUMS" 'wihm-installer.tar.gz'
  tar -xzf "$download_root/wihm-installer.tar.gz" -C "$download_root"
  package_root="$download_root/WIHM-Installer"
fi
node_bin=''
if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  node_bin=$(command -v node)
fi
if [[ -z "$node_bin" ]]; then
  if $is_termux; then printf 'Node.js 22+ is required. Update Termux packages and try again.\n' >&2; exit 1; fi
  case "$(uname -s)" in Darwin) node_os=darwin ;; Linux) node_os=linux ;; *) printf 'Unsupported OS.\n' >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) node_arch=x64 ;; arm64|aarch64) node_arch=arm64 ;; *) printf 'An x64 or ARM64 CPU is required.\n' >&2; exit 1 ;; esac
  runtime_root=$(mktemp -d "$cache_root/runtime-XXXXXXXX")
  printf 'Preparing Node.js 24 from nodejs.org...\n'
  download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$runtime_root/SHASUMS256.txt"
  node_file=$(awk -v suffix="-$node_os-$node_arch.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && substr($2, length($2)-length(suffix)+1) == suffix {print $2; exit}' "$runtime_root/SHASUMS256.txt")
  [[ "$node_file" =~ ^node-(v24\.[0-9]+\.[0-9]+)-[a-z0-9-]+\.tar\.gz$ ]] || { printf 'Cannot find a compatible Node.js runtime.\n' >&2; exit 1; }
  node_version="${BASH_REMATCH[1]}"
  download "https://nodejs.org/dist/$node_version/$node_file" "$runtime_root/$node_file"
  verify "$runtime_root/$node_file" "$runtime_root/SHASUMS256.txt" "$node_file"
  tar -xzf "$runtime_root/$node_file" -C "$runtime_root"
  node_bin="$runtime_root/${node_file%.tar.gz}/bin/node"
fi
printf 'Opening the Persian installation wizard. Keep this window open.\n'
exec "$node_bin" "$package_root/start.mjs"
