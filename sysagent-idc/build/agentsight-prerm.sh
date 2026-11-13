#!/bin/sh
set -eu
# Upgrades retain enrollment. Removal stops/disables only the managed pair and
# persists disabled consent. Config, consent and captured data are not purged.
case "${1-}" in
    remove|deconfigure)
        /usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py disable
        ;;
    upgrade|failed-upgrade)
        ;;
esac
exit 0
