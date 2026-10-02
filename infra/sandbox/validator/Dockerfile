# Headless-browser validation of a built site. Runs with --network none:
# the site is served from inside the container, so nothing can phone home.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /validator
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright-core@1.63.0 >/dev/null
COPY validate.mjs .
USER pwuser
ENTRYPOINT ["node", "/validator/validate.mjs"]
