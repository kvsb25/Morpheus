# DB_CONTAINER_NAME=${DB_CONTAINER_NAME:-"postgres-db"}
# DB_USER=${DB_USER:-postgres}
# DB_NAME=${DB_NAME:-app_database}
DB_CONTAINER_NAME=$1
DB_USER=$2
DB_NAME=$3


docker exec $DB_CONTAINER_NAME psql -U $DB_USER -d $DB_NAME -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();)"