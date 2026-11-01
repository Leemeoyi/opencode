// Stands in for a framework dev server: serves index.html and prints a local URL like Vite does.
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    if (new URL(request.url).pathname === "/") return new Response(Bun.file(`${import.meta.dir}/index.html`))
    return new Response("Not found", { status: 404 })
  },
})
console.log(`  Local:   http://localhost:${server.port}/`)
