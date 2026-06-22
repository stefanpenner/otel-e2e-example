.PHONY: up down logs ps load trigger test open jaeger clean

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

load:      ## trigger a burst of pipeline runs (make load N=50)
	./scripts/load.sh http://localhost:18080 $(or $(N),20)

trigger:   ## fire a single run (make trigger WF=ci  |  make trigger WF=deploy FAIL=1)
	@curl -s "http://localhost:18080/trigger?workflow=$(or $(WF),ci)$(if $(FAIL),&fail=1)" ; echo

test:      ## end-to-end smoke test (asserts all 3 signals land)
	./scripts/smoke-test.sh

open:      ## open Grafana
	open http://localhost:3000

jaeger:    ## open Jaeger UI
	open http://localhost:16686
