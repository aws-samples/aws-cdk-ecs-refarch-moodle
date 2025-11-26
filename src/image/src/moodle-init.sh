#!/bin/bash
set -e

# Persistence directories
MOUNT_DIR="/mnt/moodle"
PERSISTENT_DIR="/var"
MOODLE_DIR="$PERSISTENT_DIR/www/moodle"
MOODLE_DATA_DIR="$PERSISTENT_DIR/moodledata"
SOURCE_MOODLE="/opt/moodle"

# Create Moodle directories
mkdir -p "$MOUNT_DIR/moodle" "$MOUNT_DIR/moodledata"

# Create symlink for moodle
ln -sf "$MOUNT_DIR/moodle" "$MOODLE_DIR" 

# Create symlink for moodledata
ln -sf "$MOUNT_DIR/moodledata" "$MOODLE_DATA_DIR" 

    
# Check if this is first run (no persistent Moodle installation)
if [ ! -f "$MOODLE_DIR/config.php" ]; then
    echo "First run: Copying Moodle source to persistent storage..."
    cp -r "$SOURCE_MOODLE"/* "$MOODLE_DIR"/
    
    # Set ownership on mount points
    echo "Setting permissions on persistent storage..."
    chown -R www-data:www-data "$MOUNT_DIR/moodle" "$MOUNT_DIR/moodledata"
    chmod 770 "$MOUNT_DIR/moodledata"
    
    echo "Installing Moodle as www-data user..."
    cd "$MOODLE_DIR"
    sudo -u www-data php admin/cli/install.php \
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

    # Configure security and proxy settings (must be before require_once)
    echo "Configuring security and proxy settings..."
    sed -i '/require_once.*lib\/setup.php/i \
// SSL proxy configuration for CloudFront/ALB\
$CFG->sslproxy = true;\
\
// Security: Prevent executable paths from being set via Admin GUI\
$CFG->preventexecpath = true;\
' "$MOODLE_DIR/config.php"

    # Set permissions for Apache access
    echo "Setting permissions..."
    
    # Set Moodle directory writable for plugin installation
    find "$MOODLE_DIR" -type d -exec chmod 700 {} \;
    find "$MOODLE_DIR" -type f -exec chmod 600 {} \;
    
    # Moodledata must be writable by web server
    find "$MOODLE_DATA_DIR" -type d -exec chmod 700 {} \;
    find "$MOODLE_DATA_DIR" -type f -exec chmod 600 {} \;
    
    # Config.php should be read-only for security (not writable by web server)
    chmod 440 "$MOODLE_DIR/config.php"

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

# Start cron daemon
echo "Starting cron daemon..."
cron

echo "Moodle setup complete, starting Apache in foreground"
exec apache2-foreground