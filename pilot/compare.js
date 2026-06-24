import ollama from "ollama"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const imagesDir = path.join(__dirname, "images")
const outputFile = path.join(__dirname, "compare.json")
const prompt = `Describe this album cover. Your response will be used as alt text and should conform to WCAG 2.1 guidelines. Output only 1-3 sentences, the first sentence beginning with "album cover of: "`

const MODELS = ["qwen3-vl:8b", "qwen3-vl:32b"]

const files = await fs.readdir(imagesDir)
const results = {}

for (const model of MODELS) {
    console.log(`\n=== ${model} ===`)
    for (const file_name of files) {
        const start = Date.now()
        const response = await ollama.chat({
            model,
            messages: [{
                role: "user",
                content: prompt,
                images: [path.join(imagesDir, file_name)]
            }],
        })
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        const text = response.message.content
        if (!results[file_name]) results[file_name] = { file_name }
        results[file_name][model] = text
        console.log(`  [${file_name}] (${elapsed}s) ${text}`)
    }
}

const output = Object.values(results)
await fs.writeFile(outputFile, JSON.stringify(output, null, 2))
console.log(`\nWrote ${output.length} entries to ${outputFile}`)
