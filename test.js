import ollama from "ollama"

const prompt = "What's in this image? Be concise"

const response = await ollama.chat({
    model: "qwen3-vl:8b",
    messages: [{
        role: "user",
        content: prompt,
        images: ["./testimages/hum.png"]
    }],
})
console.log(response.message.content)