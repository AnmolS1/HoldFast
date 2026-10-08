# Placeholder scanner image: a hello HTTP server on :8080, so the Worker and its container deploy
# end to end before the real scanner exists. It contains no scanner.
FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
