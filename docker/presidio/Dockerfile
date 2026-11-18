# Optional PII detector for the Thinkflow privacy firewall (compose profile `privacy`).
# Presidio analyzer (Flask) + spaCy pt_core_news_lg + the Brazilian recognizers of
# tarja-presidio (Apache-2.0): CPF, CNPJ (incl. alphanumeric), CNS, NIS, CNH, RENAVAM, CEP, plate...
# Pinned to a concrete tag (2.2.362 was the newest numbered tag when written); bump deliberately.
FROM mcr.microsoft.com/presidio-analyzer:2.2.362

USER root
# --no-deps: the base image already bundles presidio-analyzer (from source); pip must not pull a
# second copy that shadows it. tarja (pure Python, no deps) is its only other requirement.
RUN pip install --no-cache-dir --no-deps "tarja-presidio==0.1.1" "tarja>=0.12,<1.0" \
 && python -m spacy download pt_core_news_lg \
 && rm -rf /root/.cache

ENV NLP_CONF_FILE=/app/conf-thinkflow/nlp.yaml \
    ANALYZER_CONF_FILE=/app/conf-thinkflow/analyzer.yaml \
    RECOGNIZER_REGISTRY_CONF_FILE=/app/conf-thinkflow/recognizers.yaml \
    PORT=3000 WORKERS=1

COPY nlp.yaml analyzer.yaml recognizers.yaml /app/conf-thinkflow/
COPY wsgi.py /app/wsgi.py
COPY --chmod=755 entrypoint.sh /app/entrypoint-thinkflow.sh
RUN chown -R 1001:1001 /app/conf-thinkflow /app/wsgi.py /app/entrypoint-thinkflow.sh

# non-root (same uid as the base image)
USER 1001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=120s --retries=3 \
  CMD curl -fs http://localhost:3000/health || exit 1
CMD ["/app/entrypoint-thinkflow.sh"]
