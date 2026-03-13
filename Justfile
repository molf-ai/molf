# Install dependencies
install:
    pnpm install

# Create a new worktree with a branch and install dependencies
worktree branch:
    git worktree add ../molf-{{replace(branch, "/", "-")}} -b {{branch}}
    cp .env ../molf-{{replace(branch, "/", "-")}}
    cd ../molf-{{replace(branch, "/", "-")}} && just install
