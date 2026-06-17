.PHONY: up down logs ps load test open clean

up:        ## build + start the whole stack
	docker compose up -d --build

down:      ## stop containers
	docker compose down

clean:     ## stop + wipe volumes (traces/logs storage)
	docker compose down -v

ps:        ## show status
	docker compose ps

logs:      ## tail all logs
	docker compose logs -f

load:      ## send traffic to the frontend (make load N=300)
	./scripts/load.sh http://localhost:18080/ $(or $(N),200)

test:      ## end-to-end smoke test (asserts all 3 signals land)
	./scripts/smoke-test.sh

open:      ## open Grafana
	open http://localhost:3000
