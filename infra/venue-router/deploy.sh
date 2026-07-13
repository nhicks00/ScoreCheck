#!/bin/sh

set -eu

ROUTER="${1:-root@192.168.8.1}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REMOTE_TMP="/tmp/scorecheck-speedify-deploy.$$"

cleanup() {
  ssh "$ROUTER" "rm -rf '$REMOTE_TMP'" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

ssh "$ROUTER" "mkdir -p '$REMOTE_TMP'"
scp -O \
  "$SCRIPT_DIR/scorecheck-speedify-routing.sh" \
  "$SCRIPT_DIR/scorecheck-speedify-soak-recorder.sh" \
  "$SCRIPT_DIR/scorecheck-speedify-watchdog.init" \
  "$ROUTER:$REMOTE_TMP/"

ssh "$ROUTER" "REMOTE_TMP='$REMOTE_TMP' sh -s" <<'REMOTE'
set -eu

cp "$REMOTE_TMP/scorecheck-speedify-routing.sh" /usr/sbin/scorecheck-speedify-routing
cp "$REMOTE_TMP/scorecheck-speedify-soak-recorder.sh" /usr/sbin/scorecheck-speedify-soak-recorder
cp "$REMOTE_TMP/scorecheck-speedify-watchdog.init" /etc/init.d/scorecheck-speedify-watchdog
chmod 0755 \
  /usr/sbin/scorecheck-speedify-routing \
  /usr/sbin/scorecheck-speedify-soak-recorder \
  /etc/init.d/scorecheck-speedify-watchdog

# Remove the obsolete fail-open tool so its old reset command cannot be used.
rm -f /root/scorecheck-speedify-routing.sh

firewall_file=/etc/firewall.user
touch "$firewall_file"
temporary="$firewall_file.scorecheck.$$"
awk '
  /^# BEGIN SCORECHECK SPEEDIFY FAIL-CLOSED$/ {skip=1; next}
  /^# END SCORECHECK SPEEDIFY FAIL-CLOSED$/ {skip=0; next}
  !skip {print}
' "$firewall_file" >"$temporary"
printf '%s\n' \
  '# BEGIN SCORECHECK SPEEDIFY FAIL-CLOSED' \
  '/usr/sbin/scorecheck-speedify-routing guard-if-enabled >/dev/null 2>&1 || logger -t scorecheck-speedify "failed to restore firewall guard"' \
  '# END SCORECHECK SPEEDIFY FAIL-CLOSED' >>"$temporary"
chmod 0644 "$temporary"
mv "$temporary" "$firewall_file"

/etc/init.d/scorecheck-speedify-watchdog enable
/etc/init.d/scorecheck-speedify-watchdog restart
/usr/sbin/scorecheck-speedify-routing guard-if-enabled
REMOTE

printf '%s\n' "Installed fail-closed Speedify routing on $ROUTER."
printf '%s\n' "No route was enabled or disabled. Run preflight, then enable with a validated bonded upload value."
