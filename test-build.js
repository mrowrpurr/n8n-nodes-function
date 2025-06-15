// Simple test to verify our refactored code compiles
const { execSync } = require("child_process")

console.log("🧪 Testing build...")

try {
	// Run TypeScript compilation
	execSync("npx tsc --noEmit", { stdio: "inherit" })
	console.log("✅ TypeScript compilation successful!")
} catch (error) {
	console.error("❌ TypeScript compilation failed:", error.message)
	process.exit(1)
}

console.log("🎉 Build test completed successfully!")
