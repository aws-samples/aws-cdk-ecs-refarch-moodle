#!/bin/bash
set -e

# Persistence directories
PERSISTENT_DIR="/moodle"
MOODLE_DIR="$PERSISTENT_DIR/moodle"
MOODLE_DATA_DIR="$PERSISTENT_DIR/moodledata"
SOURCE_MOODLE="/opt/moodle"

# Create persistent directories
mkdir -p "$MOODLE_DIR" "$MOODLE_DATA_DIR"

# Start Apache in background first to pass health checks
echo '<?php http_response_code(200); echo "Initializing..."; ?>' > /var/www/html/health.php
apache2ctl start

# Create lock to prevent multiple containers from initializing simultaneously
if ! mkdir "$PERSISTENT_DIR/.install_lock" 2>/dev/null; then
    echo "Another container is installing Moodle, waiting..."
    while [ ! -f "$MOODLE_DIR/config.php" ]; do
        sleep 10
    done
    echo "Installation completed by another container"
else
    echo "Acquired installation lock"
    
    # Check if this is first run (no persistent Moodle installation)
    if [ ! -f "$MOODLE_DIR/config.php" ]; then
        echo "First run: Copying Moodle source to persistent storage..."
        cp -r "$SOURCE_MOODLE"/* "$MOODLE_DIR"/
        
        echo "Installing Moodle..."
        cd "$MOODLE_DIR"
        php admin/cli/install.php \
            --chmod=2777 \
            --lang=en \
            --wwwroot="https://${MOODLE_DNS_NAME}" \
            --dataroot="$MOODLE_DATA_DIR" \
            --dbtype="$MOODLE_DATABASE_TYPE" \
            --dbhost="$MOODLE_DATABASE_HOST" \
            --dbport="$MOODLE_DATABASE_PORT_NUMBER" \
            --dbname="$MOODLE_DATABASE_NAME" \
            --dbuser="$MOODLE_DATABASE_USER" \
            --dbpass="$MOODLE_DATABASE_PASSWORD" \
            --fullname="$MOODLE_SITE_NAME" \
            --shortname="$MOODLE_SITE_NAME" \
            --adminuser="$MOODLE_USERNAME" \
            --adminpass="$MOODLE_PASSWORD" \
            --adminemail="$MOODLE_EMAIL" \
            --non-interactive \
            --agree-license
        echo "Moodle installation completed"

        # Configure SSL proxy settings for CloudFront/ALB (must be before require_once)
        echo "Configuring SSL proxy settings..."
        sed -i '/require_once.*lib\/setup.php/i \
// SSL proxy configuration for CloudFront/ALB\
$CFG->sslproxy = true;\
' "$MOODLE_DIR/config.php"

        # Create readiness-based health check endpoint
        echo "Creating readiness endpoint..."
        echo '<?php
        if (file_exists("/moodle/moodle/.ready")) {
            http_response_code(200);
            echo "Ready";
        } else {
            http_response_code(503);
            echo "Installing...";
        }
        ?>' > "$MOODLE_DIR/health.php"

        # Fix permissions for Apache access
        echo "Setting permissions..."
        touch "$MOODLE_DIR/.ready"
        chown -R www-data:www-data "$MOODLE_DIR" "$MOODLE_DATA_DIR"
        chmod -R 755 "$MOODLE_DIR"
        chmod 644 "$MOODLE_DIR/config.php"

        # Test Apache configuration
        apache2ctl configtest
        if [ $? -ne 0 ]; then
            echo "Apache configuration test failed!"
            exit 1
        else 
            echo "Apache configuration OK"
        fi
    else
        echo "Restoring from persistent storage..."
        echo "Running Moodle upgrade..."
        cd "$MOODLE_DIR"
        php admin/cli/upgrade.php --non-interactive
        echo "Moodle upgrade completed"
    fi
    
    # Remove lock after successful setup
    rmdir "$PERSISTENT_DIR/.install_lock" 2>/dev/null || true
fi

# Create symlink for Apache document root (Moodle 5.0+ requires /public directory)
rm -rf /var/www/html
ln -sf "$MOODLE_DIR/public" /var/www/html

# Stop background Apache and start in foreground
echo "Stopping background Apache..."
apache2ctl stop
sleep 2

echo "Moodle setup complete, starting Apache in foreground"
exec apache2-foreground