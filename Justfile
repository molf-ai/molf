# Install dependencies
install:
    pnpm install

# Create a new worktree with a branch and install dependencies
worktree branch:
    git worktree add ../molf-{{branch}} -b {{branch}}
    cp .env ../molf-{{branch}}
    cd ../molf-{{branch}} && just install
