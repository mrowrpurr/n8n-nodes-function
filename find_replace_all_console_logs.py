#!/usr/bin/env python3
"""
Script to replace all console.log/error/warn calls with logger calls in TypeScript files.
"""

import os
import re


def process_file(file_path):
    """Process a single file to replace console.* calls with logger.* calls"""
    print(f"Processing {file_path}...")

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    original_content = content
    changes_made = 0

    # Check if logger import already exists
    has_logger_import = 'from "./Logger"' in content or 'from "../Logger"' in content

    # Add logger import if it doesn't exist
    if not has_logger_import:
        # Determine the correct import path based on file location
        if "nodes/" in str(file_path) and not any(
            subdir in str(file_path)
            for subdir in [
                "Function/",
                "CallFunction/",
                "ReturnFromFunction/",
                "ConfigureFunctions/",
            ]
        ):
            # File is directly in nodes/ directory
            import_line = 'import { functionRegistryLogger as logger } from "./Logger"'
        else:
            # File is in a subdirectory of nodes/
            import_line = 'import { functionRegistryLogger as logger } from "../Logger"'

        # Find the last import statement and add our import after it
        import_pattern = r'(import.*?from.*?["\'].*?["\'])'
        imports = re.findall(import_pattern, content, re.MULTILINE)
        if imports:
            last_import = imports[-1]
            content = content.replace(last_import, f"{last_import}\n{import_line}")
            changes_made += 1
            print(f"  Added logger import: {import_line}")

    # Replace console.log calls
    patterns = [
        # console.log with template literals
        (r"console\.log\(`([^`]*)`\)", r"logger.log(`\1`)"),
        # console.log with string literals
        (r'console\.log\("([^"]*)"\)', r'logger.log("\1")'),
        (r"console\.log\('([^']*)'\)", r"logger.log('\1')"),
        # console.log with variables/expressions
        (r"console\.log\(([^)]+)\)", r"logger.log(\1)"),
        # console.error with template literals
        (r"console\.error\(`([^`]*)`([^)]*)\)", r"logger.error(`\1`\2)"),
        # console.error with string literals
        (r'console\.error\("([^"]*)"\)', r'logger.error("\1")'),
        (r"console\.error\('([^']*)'\)", r"logger.error('\1')"),
        # console.error with variables/expressions
        (r"console\.error\(([^)]+)\)", r"logger.error(\1)"),
        # console.warn with template literals
        (r"console\.warn\(`([^`]*)`([^)]*)\)", r"logger.warn(`\1`\2)"),
        # console.warn with string literals
        (r'console\.warn\("([^"]*)"\)', r'logger.warn("\1")'),
        (r"console\.warn\('([^']*)'\)", r"logger.warn('\1')"),
        # console.warn with variables/expressions
        (r"console\.warn\(([^)]+)\)", r"logger.warn(\1)"),
    ]

    for pattern, replacement in patterns:
        new_content = re.sub(pattern, replacement, content, flags=re.MULTILINE)
        if new_content != content:
            matches = len(re.findall(pattern, content, flags=re.MULTILINE))
            changes_made += matches
            print(f"  Replaced {matches} instances of {pattern}")
            content = new_content

    # Write back if changes were made
    if content != original_content:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"  ✅ {changes_made} changes made to {file_path}")
        return changes_made
    else:
        print(f"  ℹ️  No changes needed for {file_path}")
        return 0


def main():
    """Main function to process all TypeScript files"""
    files_to_process = [
        "nodes/Function/Function.node.ts",
        "nodes/CallFunction/CallFunction.node.ts",
        "nodes/ReturnFromFunction/ReturnFromFunction.node.ts",
        "nodes/ConfigureFunctions/ConfigureFunctions.node.ts",
    ]

    total_changes = 0

    for file_path in files_to_process:
        if os.path.exists(file_path):
            changes = process_file(file_path)
            total_changes += changes
        else:
            print(f"❌ File not found: {file_path}")

    print(f"\n🎉 Total changes made: {total_changes}")
    print("All console.log/error/warn calls have been replaced with logger calls!")


if __name__ == "__main__":
    main()
