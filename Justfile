# Install dependencies
install:
    bun install

# Create a new worktree with a branch and install dependencies
worktree branch:
    git worktree add ../molf-{{branch}} -b {{branch}}
    cd ../molf-{{branch}} && just install
