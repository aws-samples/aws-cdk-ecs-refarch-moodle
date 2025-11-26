#!/bin/bash
# Set PATH for cron environment
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Run Moodle cron 
# Suppress stdout but keep stderr (errors only)
cd /var/www/moodle
php admin/cli/cron.php
