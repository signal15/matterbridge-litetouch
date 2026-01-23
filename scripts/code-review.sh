#!/bin/bash
#
# Code Review Script using Claude CLI
# Usage:
#   ./scripts/code-review.sh [file|directory|--diff]
#
# Examples:
#   ./scripts/code-review.sh src/platform.ts          # Review a specific file
#   ./scripts/code-review.sh src/                     # Review all files in directory
#   ./scripts/code-review.sh --diff                   # Review uncommitted changes
#   ./scripts/code-review.sh --diff main              # Review changes vs main branch
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

REVIEW_PROMPT='You are a code reviewer for a Matterbridge plugin that controls Litetouch 2000 lighting systems.

Review the provided code for:
1. **Bugs**: Logic errors, race conditions, incorrect state handling
2. **Security**: Command injection, improper input validation
3. **Reliability**: Error handling, resource cleanup, edge cases
4. **Matter/Matterbridge**: Correct cluster usage, device lifecycle, state management
5. **Serial Communication**: Protocol correctness, timeout handling, queue management

For each finding, specify:
- **Severity**: High, Medium, or Low
- **Location**: File and line number(s)
- **Issue**: Clear description of the problem
- **Fix**: Suggested solution

Focus on real issues, not style preferences. If the code looks good, say so.

Output format:
## Findings
- **[Severity]:** Description (file:lines)

## Proposed Fixes
- Brief fix descriptions

## Questions / Assumptions
- Any clarifying questions about requirements or behavior'

usage() {
    echo "Usage: $0 [file|directory|--diff [branch]]"
    echo ""
    echo "Options:"
    echo "  file          Review a specific file"
    echo "  directory     Review all .ts files in directory"
    echo "  --diff        Review uncommitted changes (staged + unstaged)"
    echo "  --diff branch Review changes compared to specified branch"
    echo ""
    echo "Examples:"
    echo "  $0 src/platform.ts"
    echo "  $0 src/"
    echo "  $0 --diff"
    echo "  $0 --diff main"
    exit 1
}

review_content() {
    local content="$1"
    local context="$2"

    echo -e "${GREEN}Starting code review...${NC}"
    echo ""

    # Use claude CLI with the review prompt
    echo "$content" | claude --print "$REVIEW_PROMPT

Context: $context

Code to review:
\`\`\`typescript
$(cat)
\`\`\`"
}

if [ $# -eq 0 ]; then
    usage
fi

cd "$PROJECT_ROOT"

if [ "$1" == "--diff" ]; then
    # Review git diff
    BRANCH="${2:-HEAD}"

    if [ "$BRANCH" == "HEAD" ]; then
        echo -e "${YELLOW}Reviewing uncommitted changes...${NC}"
        DIFF_CONTENT=$(git diff HEAD --unified=5 -- '*.ts' 2>/dev/null || git diff --unified=5 -- '*.ts')
    else
        echo -e "${YELLOW}Reviewing changes vs $BRANCH...${NC}"
        DIFF_CONTENT=$(git diff "$BRANCH"...HEAD --unified=5 -- '*.ts')
    fi

    if [ -z "$DIFF_CONTENT" ]; then
        echo -e "${GREEN}No changes to review.${NC}"
        exit 0
    fi

    echo "$DIFF_CONTENT" | claude --print "$REVIEW_PROMPT

Context: Git diff of TypeScript changes

Diff to review:
\`\`\`diff
$(cat)
\`\`\`"

elif [ -d "$1" ]; then
    # Review directory
    DIR="$1"
    echo -e "${YELLOW}Reviewing all .ts files in $DIR...${NC}"

    FILES=$(find "$DIR" -name "*.ts" -type f | sort)
    CONTENT=""

    for file in $FILES; do
        CONTENT+="
// ===== $file =====
$(cat "$file")
"
    done

    echo "$CONTENT" | claude --print "$REVIEW_PROMPT

Context: Multiple TypeScript files from $DIR

Code to review:
\`\`\`typescript
$(cat)
\`\`\`"

elif [ -f "$1" ]; then
    # Review single file
    FILE="$1"
    echo -e "${YELLOW}Reviewing $FILE...${NC}"

    cat "$FILE" | claude --print "$REVIEW_PROMPT

Context: Single file review of $FILE

Code to review:
\`\`\`typescript
$(cat)
\`\`\`"

else
    echo -e "${RED}Error: '$1' is not a valid file or directory${NC}"
    usage
fi
