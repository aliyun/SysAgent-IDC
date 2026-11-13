#!/bin/sh
set -eu
# The packager installs the two static units under /usr/lib/systemd/system.
# setup reloads definitions and restarts only a previously valid enrollment;
# it never grants consent, creates a config or enables collection on install.
case "${1-}" in
    configure)
        /usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py setup
        ;;
    abort-upgrade|abort-remove|abort-deconfigure)
        ;;
esac
exit 0
