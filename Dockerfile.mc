FROM eclipse-temurin:25-jre

WORKDIR /data

EXPOSE 25565

CMD ["sh", "-c", "echo eula=true > eula.txt && exec java -Xmx2G -Xms2G -jar server.jar nogui"]
