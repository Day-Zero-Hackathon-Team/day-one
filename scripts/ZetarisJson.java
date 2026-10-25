// Run SQL against Zetaris over JDBC and print each result as one JSON line.
//
// Used by the app's Lookup agent (src/zetaris.ts). Needs Java 11+ and the Zetaris JDBC jar;
// no compile step:
//
//   java -cp <driver.jar> scripts/ZetarisJson.java "SELECT ..." ["SELECT ..." ...]
//
// Statements run in order on one connection. Output, one line per statement:
//   {"columns":["a","b"],"rows":[["1","x"],...]}     or     {"error":"..."}
// Values are strings (null stays null) and are never truncated.
// Connection settings: ZETARIS_URL, ZETARIS_USER, ZETARIS_PASSWORD (same as ZetarisSql.java).

import java.sql.*;

public class ZetarisJson {

    public static void main(String[] args) throws Exception {
        Class.forName("com.zetaris.lightning.jdbc.LightningDriver");
        String url = env("ZETARIS_URL", "jdbc:zetaris:lightning@localhost:10000");
        String user = env("ZETARIS_USER", "admin@zetaris.com");
        String pw = System.getenv("ZETARIS_PASSWORD");
        if (pw == null || pw.isEmpty()) fail("set ZETARIS_PASSWORD");

        Connection conn;
        try {
            conn = DriverManager.getConnection(url, user, pw);
        } catch (SQLException e) {
            fail("could not connect to " + url + ": " + shortMessage(e));
            return;
        }
        try (Connection c = conn) {
            for (String sql : args) {
                StringBuilder out = new StringBuilder();
                try (Statement s = c.createStatement()) {
                    if (!s.execute(sql)) {
                        out.append("{\"columns\":[],\"rows\":[]}");
                    } else {
                        try (ResultSet rs = s.getResultSet()) {
                            ResultSetMetaData md = rs.getMetaData();
                            int n = md.getColumnCount();
                            out.append("{\"columns\":[");
                            for (int j = 1; j <= n; j++) {
                                if (j > 1) out.append(',');
                                quote(out, md.getColumnLabel(j));
                            }
                            out.append("],\"rows\":[");
                            boolean first = true;
                            while (rs.next()) {
                                if (!first) out.append(',');
                                first = false;
                                out.append('[');
                                for (int j = 1; j <= n; j++) {
                                    if (j > 1) out.append(',');
                                    String v = rs.getString(j);
                                    if (v == null) out.append("null"); else quote(out, v);
                                }
                                out.append(']');
                            }
                            out.append("]}");
                        }
                    }
                } catch (SQLException e) {
                    out.setLength(0);
                    out.append("{\"error\":");
                    quote(out, shortMessage(e));
                    out.append('}');
                }
                System.out.println(out);
            }
        }
    }

    static void quote(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (ch < 0x20) out.append(String.format("\\u%04x", (int) ch));
                    else out.append(ch);
            }
        }
        out.append('"');
    }

    // Zetaris wraps the useful part of an error in <<< >>> inside a long server stack trace.
    static String shortMessage(SQLException e) {
        String m = String.valueOf(e.getMessage());
        int a = m.indexOf("<<<"), b = m.indexOf(">>>", a + 3);
        if (a >= 0 && b > a) m = m.substring(a + 3, b);
        m = m.split("\n")[0].trim();
        return m.length() > 400 ? m.substring(0, 400) + " ..." : m;
    }

    static String env(String k, String d) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? d : v;
    }

    static void fail(String msg) {
        System.out.println("{\"fatal\":\"" + msg.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}");
        System.exit(1);
    }
}
