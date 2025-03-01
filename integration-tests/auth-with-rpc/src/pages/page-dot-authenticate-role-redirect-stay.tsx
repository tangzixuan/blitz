import {useMutation, useSuspenseQuery} from "@blitzjs/rpc"
import {BlitzPage} from "@blitzjs/next"
import logout from "../mutations/logout"
import getAuthenticatedBasic from "../queries/getAuthenticatedBasic"
import {Suspense} from "react"

function Content() {
  const [result] = useSuspenseQuery(getAuthenticatedBasic, undefined)
  const [logoutMutation] = useMutation(logout)
  return (
    <div>
      <div id="content">{result}</div>
      <button
        id="logout"
        onClick={async () => {
          await logoutMutation()
        }}
      >
        logout
      </button>
    </div>
  )
}

const Authenticate: BlitzPage = () => {
  return (
    <div id="page">
      <Suspense fallback={"Loading..."}>
        <Content />
      </Suspense>
    </div>
  )
}

Authenticate.authenticate = {role: "USER", redirectTo: "/noauth-query"}

export default Authenticate
