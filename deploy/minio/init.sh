#!/bin/sh
# Inicialização idempotente do MinIO do Thinkflow (roda no container minio-init, imagem mc -dev).
# Cria o bucket privado, a política de privilégio mínimo e o usuário da aplicação.
# Pode ser executado quantas vezes quiser: reaplica a política e a senha do usuário.
set -eu

: "${MINIO_ROOT_USER:?defina MINIO_ROOT_USER}"
: "${MINIO_ROOT_PASSWORD:?defina MINIO_ROOT_PASSWORD}"
: "${S3_BUCKET:?defina S3_BUCKET}"
: "${S3_ACCESS_KEY_ID:?defina S3_ACCESS_KEY_ID}"
: "${S3_SECRET_ACCESS_KEY:?defina S3_SECRET_ACCESS_KEY}"
MINIO_URL="${MINIO_URL:-http://minio:9000}"
POLICY_NAME="${POLICY_NAME:-thinkflow-rw}"
INIT_DIR="$(dirname "$0")"
export MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/.mc}"

if [ "$S3_ACCESS_KEY_ID" = "$MINIO_ROOT_USER" ]; then
  echo "S3_ACCESS_KEY_ID não pode ser igual a MINIO_ROOT_USER: a aplicação não deve usar o root." >&2
  exit 1
fi

# Aguarda o MinIO aceitar o login root (até ~60 s).
i=0
until mc alias set local "$MINIO_URL" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 \
  && mc ready local >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "MinIO não ficou pronto em $MINIO_URL." >&2
    exit 1
  fi
  sleep 2
done

mc mb --ignore-existing "local/$S3_BUCKET"
mc anonymous set none "local/$S3_BUCKET" >/dev/null

# Política com o nome do bucket substituído (o arquivo no repositório usa __BUCKET__).
sed "s/__BUCKET__/$S3_BUCKET/g" "$INIT_DIR/thinkflow-policy.json" >/tmp/thinkflow-policy.json
mc admin policy create local "$POLICY_NAME" /tmp/thinkflow-policy.json

# `user add` é idempotente: se o usuário existe, apenas redefine a senha.
mc admin user add local "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
mc admin policy attach local "$POLICY_NAME" --user "$S3_ACCESS_KEY_ID" >/dev/null 2>&1 \
  || echo "Política $POLICY_NAME já anexada a $S3_ACCESS_KEY_ID."

rm -f /tmp/thinkflow-policy.json
echo "MinIO pronto: bucket '$S3_BUCKET', usuário '$S3_ACCESS_KEY_ID' com a política '$POLICY_NAME'."
