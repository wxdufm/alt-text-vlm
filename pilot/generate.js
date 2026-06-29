// generate.js
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const data = JSON.parse(await fs.readFile(path.join(__dirname, "compare.json"), "utf8"))

const rows = data.map(({ file_name, ...models }) => {
    const [m1, m2] = Object.keys(models)
    return `
    <tr>
        <td><img src="images/${file_name}" style="width:150px"><br><small>${file_name}</small></td>
        <td>${models[m1]}</td>
        <td>${models[m2]}</td>
    </tr>`
}).join("")

const html = `<table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
    <thead><tr><th>Image</th><th>30b</th><th>8b</th></tr></thead>
    <tbody>${rows}</tbody>
</table>`

await fs.writeFile(path.join(__dirname, "compare.html"), html)
console.log("Wrote compare.html")
