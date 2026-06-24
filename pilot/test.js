import ollama from "ollama"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const imagesDir = path.join(__dirname, "images")
const outputFile = path.join(__dirname, "alt_text.json")
const prompt = `Describe this album cover. Your response will be used as alt text and should conform to WCAG 2.1 guidelines. Output only 1-3 sentences, the first sentence beginning with "album cover of: "`

const files = await fs.readdir(imagesDir)
const results = []

for (const file_name of files) {
    const response = await ollama.chat({
        model: "qwen3-vl:8b",
        options: {
            "num_ctx": 32000
        },
        messages: [{
            role: "user",
            content: prompt,
            images: [path.join(imagesDir, file_name)]
        }],
    })
    const alt_text = response.message.content
    console.log(`${file_name}: ${alt_text}`)
    results.push({ file_name, alt_text })
}

await fs.writeFile(outputFile, JSON.stringify(results, null, 2))
console.log(`\nWrote ${results.length} entries to ${outputFile}`)
