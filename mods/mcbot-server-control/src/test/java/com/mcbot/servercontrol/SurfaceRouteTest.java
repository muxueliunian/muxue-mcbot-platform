package com.mcbot.servercontrol;

import java.util.List;

/** The rough surface planner of travel-to on drawn height grids, without a world. */
final class SurfaceRouteTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    /**
     * A grid from rows of text, one character per column (x to the right, z down, origin 0,0): a digit is land
     * that many blocks high (feet height 60+digit), ~ water with its surface at 60, # blocked (a trunk, lava).
     */
    private static SurfaceRoute grid(String... rows){
        SurfaceRoute grid=new SurfaceRoute(0,0,rows.length);
        for(int zz=0;zz<rows.length;zz++)for(int xx=0;xx<rows.length;xx++){
            char c=rows[zz].charAt(xx);
            if(c=='#')grid.set(xx,zz,0,SurfaceRoute.BLOCKED);
            else if(c=='~')grid.set(xx,zz,60,SurfaceRoute.WATER);
            else grid.set(xx,zz,60+c-'0',SurfaceRoute.LAND);
        }
        return grid;
    }
    private static boolean steps(List<SurfaceRoute.Cell> way){
        for(int i=1;i<way.size();i++){
            var a=way.get(i-1);var b=way.get(i);
            if(Math.abs(a.x()-b.x())>1||Math.abs(a.z()-b.z())>1)return false;
        }
        return true;
    }
    private static boolean through(List<SurfaceRoute.Cell> way,int x,int z){return way.stream().anyMatch(c->c.x()==x&&c.z()==z);}
    private static SurfaceRoute.Cell end(List<SurfaceRoute.Cell> way){return way.getLast();}
    static void run(){
        var flat=grid("00000","00000","00000","00000","00000");
        var straight=flat.plan(0,2,4.5,2.5);
        check(straight.size()==5&&steps(straight)&&end(straight).x()==4,"Flat ground: straight to the destination, one column a step");

        // A cliff five high across the way, with one column of gentle steps through it at x=4
        var cliff=grid(
            "0000000",
            "0000000",
            "5555155",
            "5555255",
            "5555155",
            "0000000",
            "0000000");
        var round=cliff.plan(1,0,1.5,6.5);
        check(end(round).z()==6&&through(round,4,3)&&steps(round),"A cliff is gone round through the only gentle way");
        check(round.stream().noneMatch(c->c.y()==65),"Never onto the cliff top");

        // Steps of two are a cliff too: a body jumps up one, and a long walk steps down one only
        var step2=grid("02","02");
        check(step2.plan(0,0,1.5,0.5).isEmpty(),"Two blocks up is no step: nothing reachable gets closer");
        var down2=grid("20","20");
        check(down2.plan(0,0,1.5,0.5).isEmpty(),"Nor two blocks down");

        // A river across the way; the far bank is high except one low spot at x=5
        var river=grid(
            "0000000",
            "0000000",
            "~~~~~~~",
            "~~~~~~~",
            "4444404",
            "0000000",
            "0000000");
        var swim=river.plan(1,0,1.5,6.5);
        check(end(swim).z()==6&&through(swim,5,4),"Swims across and climbs out at the only low bank");
        check(swim.stream().anyMatch(c->c.kind()==SurfaceRoute.WATER),"The way goes through the water");

        // A bank over three blocks above the water is not stepped down from
        var high=grid("444","~~~","000");
        check(high.plan(1,0,1.5,2.5).isEmpty(),"No jumping four blocks into the water");
        var fine=grid("333","~~~","000");
        check(end(fine.plan(1,0,1.5,2.5)).z()==2,"Three blocks down into the water is fine");

        // Walking is cheaper than swimming: a bridge one column away is taken instead of the water
        var bridge=grid(
            "00000",
            "~~~0~",
            "~~~0~",
            "~~~0~",
            "00000");
        var dry=bridge.plan(1,0,1.5,4.5);
        check(dry.stream().noneMatch(c->c.kind()==SurfaceRoute.WATER)&&through(dry,3,2),"A dry way a little longer beats swimming");

        // Corners are not cut between two blocked cells
        var corner=grid("0#","#0");
        check(corner.plan(0,0,1.5,1.5).isEmpty(),"No squeezing diagonally between two trunks");

        // Shut in a hollow: nothing reachable is closer, so no plan (the leg falls back to turning)
        var hollow=grid(
            "00000",
            "05550",
            "05050",
            "05550",
            "00000");
        check(hollow.plan(2,2,4.5,4.5).isEmpty(),"Shut in: empty plan");

        // A destination off the grid: to the reachable column closest to it
        var off=flat.plan(0,0,40.5,2.5);
        check(end(off).x()==4&&end(off).z()==2,"Destination outside the grid: to its nearest reachable column");
        var blocked=grid("00#00","00#00","00#00","00#00","00#00");
        var wall=blocked.plan(0,2,4.5,2.5);
        check(end(wall).x()==1,"A wall all the way across: as close as it gets, no further");
        check(new SurfaceRoute(0,0,3).plan(5,5,0,0).isEmpty(),"A start off the grid has no plan");
        System.out.println("SurfaceRouteTest: "+checks+" checks passed (planner on drawn grids; world sampling not tested)");
    }
}
