#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sha='0123456789abcdef0123456789abcdef01234567'
run="$(node - "$root/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs'); const YAML = require('yaml');
const workflow = YAML.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(workflow.jobs.deploy.steps.at(-1).run.replace(/^.*bash scripts\/run-ssm-deployment\.sh.*$/m, 'printf %s "$remote_command"'));
NODE
)"
remote_command="$(GITHUB_SHA="$sha" bash -c "$run")"
[[ "$remote_command" == *$'\n'* ]] || { echo 'remote command lacks LF separators' >&2; exit 1; }
[[ "$remote_command" != *'\\n'* ]] || { echo 'remote command contains literal backslash-n' >&2; exit 1; }
[[ "$remote_command" == *"deploy-production-$sha.sh"* && "$remote_command" != *'\($sha)'* ]] || { echo 'target lacks interpolated SHA' >&2; exit 1; }

fixture="$(mktemp -d)"
mkdir -p "$fixture/bin"
cat >"$fixture/bin/install" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$fixture/bin/chmod" <<'EOF'
#!/usr/bin/env bash
/bin/chmod "$@"
EOF
cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
while (($#)); do if [[ "$1" == --output ]]; then mkdir -p "$(dirname "$2")"; printf '#!/usr/bin/env bash\nprintf ok\n' >"$2"; chmod +x "$2"; exit 0; fi; shift; done
exit 1
EOF
cat >"$fixture/bin/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" != bash ]]; do shift; done
script="$3"
script="${script//\/home\/ec2-user\/apps\/perp-dashboard\/shared\/bin/$SUDO_TARGET}"
exec bash -c "$script" "${@:4}"
EOF
chmod +x "$fixture/bin"/*
PATH="$fixture/bin:$PATH" SUDO_TARGET="$fixture/target" bash -c "$remote_command" >/dev/null
rm -rf "$fixture"
echo 'workflow remote command integration tests passed'
