#!/usr/bin/env bash
set -euo pipefail

output="result.csv"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    -h)
      echo "fake cfst"
      exit 0
      ;;
    *)
      shift
      ;;
  esac
done

mkdir -p "$(dirname "$output")"
cat > "$output" <<'CSV'
IP 地址,已发送,已接收,丢包率,平均延迟,下载速度 (MB/s),地区码
1.1.1.1,4,4,0.00%,12.10,9.50,HKG
2.2.2.2,4,4,0.00%,21.20,6.10,NRT
CSV
echo "fake cfst wrote $output"
