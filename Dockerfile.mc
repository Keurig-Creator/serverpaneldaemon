FROM eclipse-temurin:25-jre

WORKDIR /data

EXPOSE 25565

# Run the server.jar that lives in the mounted /data volume (Paper 26.1.2,
# the build that generated the world). eula.txt is written at runtime because
# the ./data/<server>:/data bind mount shadows anything baked into the image.
CMD ["sh", "-c", "echo eula=true > eula.txt && exec java -Xmx2G -Xms2G -jar server.jar nogui"]
