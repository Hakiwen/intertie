.PHONY: check test typecheck vectors
check: ## typecheck + all tests (CI runs this)
	npm test
test: check
typecheck:
	npm run typecheck
vectors: ## regenerate spec/test-vectors from the fixed seed
	node scripts/gen-test-vectors.ts
