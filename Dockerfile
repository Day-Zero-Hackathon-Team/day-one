# Day One: web app + agent API on port 3100. No npm dependencies, so nothing installs at run time.
#
#   docker build -t day-one .
#   docker run --rm -p 3100:3100 -e SAMPLE_MODE=true day-one          # no Nightshift or Zetaris needed
#   docker run --rm -p 3100:3100 --env-file .env day-one              # live (see README → For judges)
FROM eclipse-temurin:21-jdk AS java

FROM node:24-slim

# Java runs the Zetaris JDBC driver (live mode only; sample mode never starts it). It has to be a
# JDK: scripts/ZetarisJson.java runs as a single source file, which needs the compiler.
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk \
    PATH=/opt/java/openjdk/bin:$PATH

WORKDIR /app
COPY . .
RUN mkdir -p logs runs

# Listen on all interfaces so the port mapping reaches the server from outside the container.
ENV HOST=0.0.0.0 \
    PORT=3100
EXPOSE 3100

CMD ["node", "--experimental-transform-types", "--no-warnings", "src/server.ts"]
