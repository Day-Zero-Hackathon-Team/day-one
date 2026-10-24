// Run SQL against Zetaris over JDBC and print the results as a table.
//
// Needs Java 11+ and the Zetaris JDBC jar (zetaris-platform/jdbc/). No compile step:
//
//   java -cp <driver.jar> scripts/ZetarisSql.java "SELECT COUNT(*) FROM DAY_ONE.drug_reference"
//
// Several statements can be passed as separate arguments; they run in order on one
// connection, and the first failure stops the run with exit code 1.
// Usually run through scripts/load_to_zetaris.sh, which finds the jar and the login for you.
//
// Connection settings come from environment variables:
//   ZETARIS_URL       default jdbc:zetaris:lightning@localhost:10000
//   ZETARIS_USER      the web-interface login, e.g. admin@zetaris.com
//   ZETARIS_PASSWORD  its password
//   ZETARIS_QUIET=1   print only result rows (no "> statement" echo, header or row count)

import java.sql.*;
import java.util.*;

public class ZetarisSql {

    static boolean quiet = "1".equals(System.getenv("ZETARIS_QUIET"));

    public static void main(String[] args) throws Exception {
        if (args.length == 0) die("usage: ZetarisSql.java \"<statement>\" [\"<statement>\" ...]");
        Class.forName("com.zetaris.lightning.jdbc.LightningDriver");
        String url = env("ZETARIS_URL", "jdbc:zetaris:lightning@localhost:10000");
        String user = env("ZETARIS_USER", "admin@zetaris.com");
        String pw = System.getenv("ZETARIS_PASSWORD");
        if (pw == null || pw.isEmpty()) die("set ZETARIS_PASSWORD (the web-interface password)");

        Connection c = null;
        try {
            c = DriverManager.getConnection(url, user, pw);
        } catch (SQLException e) {
            die("could not connect to " + url + " as " + user + ": " + shortMessage(e)
                    + "\n  Is Zetaris running? ./verify.sh in the Zetaris folder should pass.");
        }
        try (Connection conn = c) {
            for (String sql : args) {
                try {
                    runAndPrint(conn, sql);
                } catch (SQLException e) {
                    die(shortMessage(e) + "\n  while running: " + sql);
                }
            }
        }
    }

    static void runAndPrint(Connection c, String sql) throws SQLException {
        if (!quiet) System.out.println("\n> " + sql);
        try (Statement s = c.createStatement()) {
            if (!s.execute(sql)) { if (!quiet) System.out.println("OK"); return; }
            try (ResultSet rs = s.getResultSet()) {
                ResultSetMetaData md = rs.getMetaData();
                int n = md.getColumnCount();
                List<String[]> out = new ArrayList<>();
                String[] head = new String[n];
                for (int j = 0; j < n; j++) head[j] = md.getColumnLabel(j + 1);
                out.add(head);
                while (rs.next()) {
                    String[] r = new String[n];
                    for (int j = 0; j < n; j++) {
                        String v = rs.getString(j + 1);
                        v = v == null ? "NULL" : v.replaceAll("\\s+", " ");
                        r[j] = v.length() > 60 ? v.substring(0, 57) + "..." : v;
                    }
                    out.add(r);
                }
                if (quiet) {
                    for (int i = 1; i < out.size(); i++) System.out.println(String.join("\t", out.get(i)));
                    return;
                }
                int[] w = new int[n];
                for (String[] r : out) for (int j = 0; j < n; j++) w[j] = Math.max(w[j], r[j].length());
                for (int i = 0; i < out.size(); i++) {
                    StringBuilder line = new StringBuilder();
                    for (int j = 0; j < n; j++) {
                        if (j > 0) line.append(" | ");
                        line.append(String.format("%-" + w[j] + "s", out.get(i)[j]));
                    }
                    System.out.println(line.toString().replaceAll("\\s+$", ""));
                    if (i == 0) {
                        StringBuilder sep = new StringBuilder();
                        for (int j = 0; j < n; j++) sep.append(j > 0 ? "-|-" : "").append("-".repeat(w[j]));
                        System.out.println(sep);
                    }
                }
                System.out.println("(" + (out.size() - 1) + " rows)");
            }
        }
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

    static void die(String msg) {
        System.err.println("ERROR: " + msg);
        System.exit(1);
    }
}
