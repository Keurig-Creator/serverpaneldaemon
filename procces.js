// fake-server.js

console.log("server running");
setInterval(() => {
    console.log("logging");
}, 1000);

process.on('exit', (code) => {
    console.log("server shutting down..")
})

process.stdin.on("data", (data) => {
    const input = data.toString().trim();
});