FROM node:24-alpine
WORKDIR /app
COPY proxy.mjs .
USER node
EXPOSE 3128
CMD ["node", "proxy.mjs"]
